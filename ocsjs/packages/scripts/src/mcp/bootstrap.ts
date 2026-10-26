/**
 * MCP bundle bootstrap（F8，ADR-0019 §4）：
 * 必须是 bundle 中最先执行的模块（ES import 顺序保证）——
 * 1. 幂等标记；
 * 2. MCP 模式标记（不可变，先于一切框架生命周期）；
 * 3. GM shim（存储/通知/tab/notify/xmlhttpRequest 错误桩）；
 * 4. frame 本地桥（题目队列 / 下行处理 / document 代次）；
 * 5. hello 事件（server 据此追踪 frame 代次并下发存储快照）。
 *
 * 之后 entry-mcp.js 再引入框架 bundle 并 start()。
 * 不依赖多 init script 顺序：全部逻辑在单一 IIFE 内。
 */

import { markMCPMode } from './mode';
import { installGMShim } from './gm-shim';
import { installBridge } from './bridge';

// 重复注入幂等（addInitScript 在同文档多次执行时保护）
if (!globalThis.__OCS_MCP_BOOTSTRAPPED__) {
	globalThis.__OCS_MCP_BOOTSTRAPPED__ = true;

	markMCPMode();
	installGMShim();
	const bridge = installBridge();

	// 在任何页面脚本重写 window.fetch 之前捕获原始引用：
	// 学习通页面的监控/机器人 SDK 会包装 fetch，包装器对 bundle 内的 AbortSignal 等参数
	// 会抛 "Illegal invocation"，导致字体解密特征表下载失败。
	try {
		(globalThis as unknown as Record<string, unknown>).__OCS_NATIVE_FETCH__ = window.fetch.bind(window);
	} catch {
		// 忽略
	}

	// easy-us CustomWindow.mount 在空 body 上执行 children[random].after() 会抛错，
	// 且 start.js 的 mounted 标志已先置位导致永不重试（面板永久丢失）。
	// 本 bundle 在 document-start 注入（早于油猴的 document-idle），需要在挂载前保证 body 有元素子节点。
	const ensureMountAnchor = () => {
		try {
			if (document.body && document.body.children.length === 0) {
				document.body.appendChild(document.createElement('div'));
			}
		} catch {
			// 忽略
		}
	};
	document.addEventListener('readystatechange', ensureMountAnchor);

	// hello：server 据此追踪 document 代次（代次变化 = frame 重生 → 绑定 run aborted）并下发存储快照
	bridge.notify('hello', { href: location.href }).catch(() => undefined);

	console.log(`[mcp-xxt] bootstrap done (gen=${bridge.gen}, href=${location.href})`);
}
