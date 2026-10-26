/**
 * Playwright 浏览器宿主（ADR-0001）：
 * - chromium 有头 + 持久 profile（.browser-profile，承载登录态）
 * - bypassCSP 显式开启（ADR-0019 §4）
 * - 每导航注入 MCP bundle（addInitScript 覆盖新文档与全部子 frame，幂等）
 * - context.exposeBinding('__mcpEvent') 接收各 frame 上行事件（含来源 page/frame）
 */

import { chromium, BrowserContext, Page, Frame } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const COURSE_STUDY_URL_PATTERN = /\/mycourse\/studentstudy/;
/** 手动答题页（作业/整卷预览/随堂练习） */
export const WORK_PAGE_PATTERNS: RegExp[] = [
	/\/mooc2\/work\/dowork/,
	/\/mooc2\/exam\/preview/,
	/\/page\/quiz\/stu\/answerQuestion2/
];

export interface FrameRef {
	frame: Frame;
	url: string;
	gen: string;
}

export class BrowserHost {
	private context: BrowserContext | null = null;
	private bundleScript: string | null = null;
	private pageKeys = new WeakMap<Page, string>();
	private pages = new Set<Page>();
	/** frame 引用（pageKey → frameKey(gen) 列表），供跨源存储中继与快照下发 */
	private frameRefs = new Map<string, Map<string, FrameRef>>();

	constructor(
		private profileDir: string,
		private onEvent: (args: { page: Page; frame: Frame; type: string; payload: Record<string, unknown> }) => Promise<unknown>,
		private onPageClosed: (pageKey: string) => void,
		private onFrameEvent: (page: Page, frame: Frame, type: string, payload: Record<string, unknown>) => void
	) {}

	async ensureContext(): Promise<BrowserContext> {
		if (this.context) return this.context;
		this.bundleScript = this.loadBundle();

		const context = await chromium.launchPersistentContext(this.profileDir, {
			headless: false,
			bypassCSP: true,
			viewport: null,
			args: ['--start-maximized'],
			acceptDownloads: false
		});
		this.context = context;

		// 上行事件绑定：全 context 所有 page/frame 可用；回调可返回确认值（work-detected 确认制）
		await context.exposeBinding('__mcpEvent', async (source, type: string, payload: Record<string, unknown>) => {
			const page = source.page;
			const frame = source.frame;
			if (!page || !frame) return { ok: false, reason: 'no source frame' };
			this.trackPage(page);
			this.trackFrame(page, frame, payload);
			this.onFrameEvent(page, frame, type, payload);
			try {
				return await this.onEvent({ page, frame, type, payload: payload ?? {} });
			} catch (err) {
				log.error('[binding] event handler error:', err);
				return { ok: false, reason: String(err) };
			}
		});

		// 每导航注入 bundle（幂等由 bundle 内 bootstrap 标记保证；覆盖子 frame 与新文档）
		await context.addInitScript({ content: this.bundleScript });

		context.on('page', (page) => this.trackPage(page));

		log.info(`[browser] persistent context launched (profile=${this.profileDir})`);
		return context;
	}

	private loadBundle(): string {
		// dist/index.js 同级查找 dist-bundle/bundle.iife.js（脚本同步自 ocsjs fork 构建产物）
		const candidates = [
			path.resolve(__dirname, '../../dist-bundle/bundle.iife.js'),
			path.resolve(__dirname, '../dist-bundle/bundle.iife.js'),
			path.resolve(process.cwd(), 'dist-bundle/bundle.iife.js')
		];
		for (const p of candidates) {
			if (existsSync(p)) {
				log.info(`[browser] bundle loaded: ${p}`);
				return readFileSync(p, 'utf8');
			}
		}
		throw new Error(
			'未找到 MCP bundle（dist-bundle/bundle.iife.js）。请先在 ocsjs fork 运行 `node scripts/build-mcp.js` 构建，并经 server 的 sync-bundle 脚本同步。'
		);
	}

	private trackPage(page: Page): string {
		let key = this.pageKeys.get(page);
		if (!key) {
			key = `page-${Math.random().toString(36).slice(2, 10)}`;
			this.pageKeys.set(page, key);
			this.pages.add(page);
			page.on('close', () => {
				this.pages.delete(page);
				this.frameRefs.delete(key!);
				this.onPageClosed(key!);
			});
			log.info(`[browser] page tracked ${key} (${page.url()})`);
		}
		return key;
	}

	getPageKey(page: Page): string {
		return this.trackPage(page);
	}

	getPage(pageKey: string): Page | undefined {
		for (const p of this.pages) {
			if (this.pageKeys.get(p) === pageKey) return p;
		}
		return undefined;
	}

	listPages(): Page[] {
		return Array.from(this.pages);
	}

	private trackFrame(page: Page, frame: Frame, payload: Record<string, unknown>) {
		const pageKey = this.trackPage(page);
		let frames = this.frameRefs.get(pageKey);
		if (!frames) {
			frames = new Map();
			this.frameRefs.set(pageKey, frames);
		}
		const gen = String(payload.gen ?? '');
		frames.set(gen, { frame, url: frame.url(), gen });
	}

	/** 页面内全部 frame 引用（跨源存储中继用） */
	getFrames(pageKey: string): FrameRef[] {
		return Array.from(this.frameRefs.get(pageKey)?.values() ?? []);
	}

	/** 当前 page 顶层 frame */
	mainFrame(page: Page): Frame {
		return page.mainFrame();
	}

	async newPage(url: string): Promise<{ page: Page; pageKey: string }> {
		const context = await this.ensureContext();
		const page = await context.newPage();
		const pageKey = this.trackPage(page);
		await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
		return { page, pageKey };
	}

	async navigate(page: Page, url: string): Promise<void> {
		await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
	}

	/** 共享 cookie 的服务端请求（图片下载走 server，ADR-0019 §2） */
	async requestBinary(url: string, referer?: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
		const context = await this.ensureContext();
		try {
			const resp = await context.request.get(url, {
				headers: referer ? { Referer: referer } : undefined,
				timeout: 30_000
			});
			if (!resp.ok()) {
				log.warn(`[browser] requestBinary ${resp.status()} ${url}`);
				return null;
			}
			const buffer = await resp.body();
			const mimeType = resp.headers()['content-type']?.split(';')[0] || 'image/png';
			return { buffer, mimeType };
		} catch (err) {
			log.warn('[browser] requestBinary failed:', err);
			return null;
		}
	}

	async screenshot(page: Page): Promise<string> {
		const buffer = await page.screenshot({ fullPage: false });
		return buffer.toString('base64');
	}

	async close() {
		if (this.context) {
			await this.context.close().catch(() => undefined);
			this.context = null;
			log.info('[browser] context closed');
		}
	}

	/** 检查页面是否仍存活 */
	isPageAlive(pageKey: string): boolean {
		return !!this.getPage(pageKey);
	}
}
