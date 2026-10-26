/**
 * 登录（D7，ADR-0008/0012）：
 * - 持久 profile cookie 承载登录态；
 * - open_login 自动尝试配置的账号密码；
 * - 验证码/风控一律转人工（截图返回），不做任何打码/绕过。
 */

import { BrowserHost } from './browser.js';
import { log } from './log.js';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface AccountConfig {
	username?: string;
	password?: string;
}

export function loadAccountConfig(): AccountConfig {
	const candidates = [
		path.resolve(__dirname, '../../config/account.json'),
		path.resolve(__dirname, '../config/account.json'),
		path.resolve(process.cwd(), 'config/account.json'),
		// 兼容根目录 passwd.json（仅密码）
		path.resolve(process.cwd(), '../passwd.json'),
		path.resolve(process.cwd(), 'passwd.json')
	];
	for (const p of candidates) {
		if (existsSync(p)) {
			try {
				const raw = JSON.parse(readFileSync(p, 'utf8'));
				log.info(`[login] account config loaded: ${p}`);
				return { username: raw.username ?? raw.phone ?? raw.account, password: raw.password };
			} catch (err) {
				log.warn(`[login] account config parse failed (${p}): ${err}`);
			}
		}
	}
	return {};
}

const LOGIN_URL = 'https://passport2.chaoxing.com/login?fid=&newversion=true&refer=http%3A%2F%2Fi.chaoxing.com';

/** 登录态检测：依赖持久 profile 的关键 cookie */
export async function checkLoginStatus(browser: BrowserHost): Promise<{ loggedIn: boolean; detail: string }> {
	const context = await browser.ensureContext();
	const cookies = await context.cookies('https://www.chaoxing.com');
	const uid = cookies.find((c) => c.name === 'UID' || c.name === '_uid');
	if (uid && uid.value && uid.value !== '') {
		return { loggedIn: true, detail: `检测到登录 cookie（${uid.name}）` };
	}
	// cookie 缺失时访问个人首页复核（可能未携带到上述域名）
	const page = await context.newPage();
	try {
		await page.goto('https://i.chaoxing.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
		const url = page.url();
		if (/passport|login/i.test(url)) {
			return { loggedIn: false, detail: '个人首页重定向到登录页' };
		}
		const loggedIn = await page
			.evaluate(() => !!document.querySelector('.user-name, .welcome, [href*="logout"]'))
			.catch(() => false);
		return { loggedIn, detail: loggedIn ? '个人首页包含用户信息' : '个人首页未检测到用户信息' };
	} finally {
		await page.close().catch(() => undefined);
	}
}

export interface LoginResult {
	status: 'ok' | 'need-human' | 'failed';
	detail: string;
	screenshotBase64?: string;
}

export async function openLogin(browser: BrowserHost, account: AccountConfig): Promise<LoginResult> {
	const context = await browser.ensureContext();
	const page = await context.newPage();
	try {
		await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
		await page.waitForTimeout(1500);

		// 已登录：登录页可能自动跳转
		if (!/passport/.test(page.url())) {
			return { status: 'ok', detail: '已有登录态（登录页自动跳转）' };
		}

		if (!account.username || !account.password) {
			return {
				status: 'need-human',
				detail: '未配置账号（server/config/account.json），请人工登录；完成后在浏览器中保持登录态即可。',
				screenshotBase64: await browser.screenshot(page)
			};
		}

		// 自动尝试账号密码（超星新版登录页：手机号输入框 + 密码 + 登录按钮）
		const phoneInput = page.locator('#phone').first();
		if (await phoneInput.isVisible().catch(() => false)) {
			await phoneInput.fill(account.username);
		} else {
			return {
				status: 'need-human',
				detail: '登录页结构变化或需要验证码，请人工登录。',
				screenshotBase64: await browser.screenshot(page)
			};
		}
		await page.locator('#pwd').first().fill(account.password);

		// 验证码/风控检测：geetest 滑块或点选出现即转人工（不打码）
		const captchaVisible = await page
			.locator('.geetest_box, .geetest_panel, [class*="captcha"], .yidun_panel')
			.first()
			.isVisible()
			.catch(() => false);
		if (captchaVisible) {
			return {
				status: 'need-human',
				detail: '检测到验证码/风控，已转人工处理；请在浏览器窗口完成验证，登录态将由持久 profile 保留。',
				screenshotBase64: await browser.screenshot(page)
			};
		}

		await page.locator('#loginBtn, .login-btn').first().click();
		await page.waitForTimeout(3000);

		// 登录后校验
		const status = await checkLoginStatus(browser);
		if (status.loggedIn) {
			return { status: 'ok', detail: '账号密码登录成功。' };
		}

		const captchaAfter = await page
			.locator('.geetest_box, .geetest_panel, [class*="captcha"], .yidun_panel')
			.first()
			.isVisible()
			.catch(() => false);
		if (captchaAfter) {
			return {
				status: 'need-human',
				detail: '登录触发验证码/风控，已转人工处理；请在浏览器窗口完成验证。',
				screenshotBase64: await browser.screenshot(page)
			};
		}
		return {
			status: 'failed',
			detail: '账号密码登录未生效，请人工检查页面提示。',
			screenshotBase64: await browser.screenshot(page)
		};
	} catch (err) {
		log.error('[login] error:', err);
		return {
			status: 'failed',
			detail: `登录流程异常：${String(err)}`,
			screenshotBase64: await browser.screenshot(page).catch(() => undefined)
		};
	} finally {
		await page.close().catch(() => undefined);
	}
}
