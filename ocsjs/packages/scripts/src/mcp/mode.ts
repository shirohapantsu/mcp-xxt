/**
 * MCP 模式标记（ADR-0019 §1）：
 * 在 GM shim 阶段（任何框架生命周期之前）设置，不可由面板配置改变；
 * 媒体硬禁用、commonWork 外部控制器等所有改造点据此判断，
 * 不得以"桥是否存在"作判断（onstart 阶段桥尚未注册）。
 */

declare global {
	// eslint-disable-next-line no-var
	var __OCS_MCP__: true | undefined;
	// eslint-disable-next-line no-var
	var __OCS_MCP_BOOTSTRAPPED__: boolean | undefined;
}

export function markMCPMode() {
	if (!globalThis.__OCS_MCP__) {
		Object.defineProperty(globalThis, '__OCS_MCP__', {
			value: true as const,
			writable: false,
			configurable: false,
			enumerable: true
		});
	}
}

export function isMCPMode(): boolean {
	return globalThis.__OCS_MCP__ === true;
}
