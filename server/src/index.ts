/**
 * mcp-xxt server 入口：stdio MCP server，注册 11 个工具；业务日志走 stderr。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserHost } from './browser.js';
import { EventRouter } from './inject.js';
import { Adapters } from './adapters.js';
import { RunManager } from './run-manager.js';
import { registerTools, ToolDeps } from './tools.js';
import { log } from './log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
	const rm = new RunManager();

	// browser ↔ router 相互引用：经 late-bound holder 打断循环
	let routerRef: EventRouter | undefined;

	const browser: BrowserHost = new BrowserHost(
		path.resolve(__dirname, '../.browser-profile'),
		// onEvent：绑定回调（含确认制返回值）
		async (args) => routerRef!.onEvent(args),
		// onPageClosed：页面关闭 → 该页未终态 run 全部 aborted（frame 分离/页面失效）
		(pageKey) => {
			const aborted = rm.handlePageClosed(pageKey);
			for (const run of aborted) log.warn(`[run ${run.id}] aborted: 页面关闭`);
			const session = rm.getCurrentSession();
			if (session?.pageKey === pageKey) {
				rm.terminateSession(session.id, 'page-invalid', '页面已关闭');
			}
		},
		// onFrameEvent：事件前追踪（frameRefs 维护）
		() => undefined
	);

	const router: EventRouter = new EventRouter(browser, rm);
	routerRef = router;

	const adapters: Adapters = new Adapters(browser, rm, router);

	let currentPage: import('playwright').Page | undefined;
	const deps: ToolDeps = {
		browser,
		rm,
		router,
		adapters,
		currentPage: () => currentPage,
		setCurrentPage: (p) => {
			currentPage = p;
		}
	};

	// deadline 兜底清扫（页面竞态是主机制，此处仅处理页面/frame 不可达）
	setInterval(() => {
		rm.sweepDeadlines(
			(pageKey) => browser.isPageAlive(pageKey),
			async (run) => {
				try {
					await router.sendToRun(run.id, { kind: 'read-result' });
					return true;
				} catch {
					return false;
				}
			}
		);
	}, 10_000).unref();

	const server = new McpServer({ name: 'mcp-xxt', version: '0.1.0' });
	registerTools(server, deps);

	const transport = new StdioServerTransport();
	await server.connect(transport);
	log.info('mcp-xxt server started (stdio)');

	const shutdown = async () => {
		log.info('shutting down...');
		await browser.close();
		process.exit(0);
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);
}

main().catch((err) => {
	log.error('fatal:', err);
	process.exit(1);
});
