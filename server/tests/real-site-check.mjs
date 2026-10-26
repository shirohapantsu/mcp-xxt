/**
 * 真实站点保守验证（开发文档 §8 真实账号验收的自动化安全子集）：
 *   open_login（自动尝试，验证码转人工）→ open_page(课程学习页) → 等待 work-detected →
 *   get_pending_questions 验证题目抓取 → abort_run 收尾。
 *
 * 安全边界：不调用 submit_answer / submit_paper —— 不向平台写入任何答案。
 * 运行：node tests/real-site-check.mjs [--no-login]
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BrowserHost } from '../dist/browser.js';
import { EventRouter } from '../dist/inject.js';
import { RunManager } from '../dist/run-manager.js';
import { openLogin, checkLoginStatus } from '../dist/login.js';
import { COURSE_STUDY_URL_PATTERN } from '../dist/browser.js';

const COURSE_URL =
	'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=1249930684&courseId=267298804&clazzid=155243931&cpi=508143193&enc=8fcf7639cfb4a7411988de939dbd9546&mooc2=1&hidetype=0&fanyaVersion=0&openc=1611db8e9d874237e377d37667e68559';

const SKIP_LOGIN = process.argv.includes('--no-login');

async function main() {
	const rm = new RunManager();
	let routerRef;
	const browser = new BrowserHost(
		mkdtempSync(path.join(tmpdir(), 'mcp-xxt-real-')),
		async (args) => routerRef.onEvent(args),
		() => undefined,
		() => undefined
	);
	const router = new EventRouter(browser, rm);
	routerRef = router;

	// ---- 登录 ----
	if (!SKIP_LOGIN) {
		console.log('[real] 打开登录页（自动尝试账号密码）...');
		const loginResult = await openLogin(browser, { username: '13133306553', password: 'xxt2006@' });
		console.log('[real] 登录结果:', loginResult.status, '-', loginResult.detail);
		if (loginResult.screenshotBase64) {
			writeFileSync('/tmp/mcp-login.png', Buffer.from(loginResult.screenshotBase64, 'base64'));
			console.log('[real] 截图: /tmp/mcp-login.png');
		}
		if (loginResult.status === 'failed') {
			await browser.close();
			process.exit(1);
		}
		const status = await checkLoginStatus(browser);
		console.log('[real] 登录态:', JSON.stringify(status));
		if (!status.loggedIn) {
			console.log('[real] 未登录，终止（请人工完成登录后用持久 profile 重试）');
			await browser.close();
			process.exit(2);
		}
	}

	// ---- 打开课程学习页 ----
	const ctx = await browser.ensureContext();
	const page = await ctx.newPage();
	browser.getPageKey(page);
	// 捕获页面 console 错误与异常（面板/框架问题诊断）
	const pageErrors = [];
	page.on('pageerror', (err) => pageErrors.push(String(err).slice(0, 200)));
	page.on('console', (msg) => {
		if (msg.type() === 'error') pageErrors.push('[console.error] ' + msg.text().slice(0, 200));
	});
	console.log('[real] 打开课程学习页...');
	rm.createSession('pending-page');
	await browser.navigate(page, COURSE_URL);
	const pageKey = browser.getPageKey(page);
	const session = rm.getCurrentSession();
	if (session) rm.rebindSessionPage(session.id, pageKey);
	await page.waitForTimeout(8000);

	console.log('[real] 页面 URL:', page.url());
	console.log('[real] 命中课程页:', COURSE_STUDY_URL_PATTERN.test(page.url()), 'session:', session?.id);

	// frame 与桥观察
	const frames = page.frames().map((f) => f.url());
	console.log(`[real] frame 数量: ${frames.length}`);
	const bridges = [];
	for (const f of page.frames()) {
		try {
			const has = await f.evaluate('!!window.__OCS_MCP_BRIDGE__');
			if (has) bridges.push(f.url().slice(0, 90));
		} catch {
			// 跨域或执行失败
		}
	}
	console.log(`[real] 注册桥的 frame: ${bridges.length}`);
	for (const b of bridges) console.log('  -', b);

	// 面板观察（top frame 内 easy-us 悬浮面板：<container-element> / .header-menu-bar）
	try {
		// 面板 wrapper 是 body 下带 inline 定位样式的普通 div（内容在 closed shadow root，查询不到内部）
		const panel = await page.evaluate(
			'Array.from(document.body?.children ?? []).filter(c => c.tagName === "DIV" && /position/.test(c.getAttribute("style") || "")).length'
		);
		console.log('[real] easy-us 面板 wrapper 存在（closed shadow root）:', panel > 0 ? `是（${panel} 个）` : '否');
	} catch {
		/* ignore */
	}

	// ---- 等待 work-detected / 遍历事件（最多 90s） ----
	console.log('[real] 等待遍历事件（work-ready / blocked / finished，最多 90s）...');
	const resp = await rm.waitNextWork(90_000);
	console.log('[real] wait_next_work →', JSON.stringify(resp));

	if (resp.event === 'work-ready') {
		const run = rm.getRun(resp.run_id);
		console.log('[real] run:', run.id, 'job:', run.jobName, 'identity:', JSON.stringify(run.identity));
		// 等题目入队（含字体解密等待，最多 25s）
		for (let i = 0; i < 25 && run.questions.size === 0; i++) await new Promise((r) => setTimeout(r, 1000));
		const questions = Array.from(run.questions.values());
		console.log(`[real] 题目 ${questions.length} 道:`);
		for (const q of questions) {
			console.log(`  - [${q.type}] ${q.title.slice(0, 60)} | options=${(q.options ?? []).length} | images=${(q.images ?? []).length} | status=${q.status}`);
		}
		if (questions.length > 0) {
			const q0 = questions[0];
			console.log('[real] 首题完整元数据:', JSON.stringify({ ...q0, title: q0.title.slice(0, 80) }));
		}
		// 安全收尾：取消 run（不回填、不提交）
		console.log('[real] abort_run（保守收尾，未回填任何答案）');
		await rm.abortRun(run.id, 'real-site-check abort');
		await router.pushCancel(run.id, 'real-site-check abort');
	} else {
		// 观察日志事件
		const evs = session ? session.events.slice(-10) : [];
		console.log('[real] 最近事件:');
		for (const e of evs) console.log(`  - #${e.eventId} ${e.type} ${JSON.stringify(e.payload).slice(0, 120)}`);
	}

	console.log('\n[real] 页面错误/错误日志（前 10 条）:');
	for (const e of pageErrors.slice(0, 10)) console.log('  !', e);
	console.log('[real] 完成（浏览器保持打开 10s 以便人工观察面板）');
	await new Promise((r) => setTimeout(r, 10_000));
	await browser.close();
	process.exit(0);
}

main().catch(async (err) => {
	console.error('[real] 失败：', err);
	process.exit(1);
});
