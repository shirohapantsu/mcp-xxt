/**
 * GM shim（F1，D16 / ADR-0019 §2 / ADR-0020 §1 / ADR-0021 §1）
 *
 * 接口兼容层规范：
 * - 存储：GM_setValue/getValue/deleteValue/listValues → localStorage（按 origin 隔离）；
 *   跨源 frame 读不到同源写入的值，由 server 中继"值镜像"兜底（bridge 的 mirror）。
 * - 通知：GM_addValueChangeListener/removeValueChangeListener **必须实现**——
 *   easy-us cors/面板通信全链路基于存储监听且无超时，no-op 会静默永久挂起：
 *   · 本 frame 写入时同步分发监听器（remote=false）；
 *   · 同源 frame 经 BroadcastChannel（remote=true）；
 *   · 跨源 frame 经 exposeBinding/server 中继（先写值镜像、再 remote=true 通知，
 *     跨源 localStorage 不共享，只发信号不写值会导致读取失败）。
 *   浏览器原生 storage 事件不覆盖写入者自身 frame，不能单独胜任。
 * - tab API：GM_getTab/saveTab → localStorage 加前缀（单 tab 直通）；
 *   cx 闯关防循环计数（$store.getTab/setTab('chapter_counter')）依赖其可用。
 * - GM_notification → __mcpEvent('log')；GM_xmlhttpRequest 不做页面侧假实现（图片下载走 server），
 *   仅提供立即失败的错误桩防止调用方静默挂起；unsafeWindow = window；GM_info 提供最小结构。
 */

import { isMCPMode } from './mode';

const GM_STORAGE_PREFIX = '__ocs_gm__:';
const GM_TAB_PREFIX = '__ocs_gm_tab__:';
const BROADCAST_CHANNEL_NAME = '__ocs_gm_broadcast__';

type ValueChangeListener = (
	name: string,
	oldValue: unknown,
	newValue: unknown,
	remote: boolean
) => void;

interface ShimState {
	listeners: Map<number, { key: string; listener: ValueChangeListener }>;
	bc: BroadcastChannel | undefined;
	mirror: Map<string, unknown>;
	nextListenerId: number;
}

const state: ShimState = {
	listeners: new Map(),
	bc: undefined,
	mirror: new Map(),
	nextListenerId: 1
};

function readRaw(key: string): unknown {
	try {
		const raw = localStorage.getItem(GM_STORAGE_PREFIX + key);
		if (raw !== null) return JSON.parse(raw);
	} catch {
		// localStorage 不可用（隐私模式等），退回 mirror
	}
	if (state.mirror.has(key)) return state.mirror.get(key);
	return undefined;
}

function writeRaw(key: string, value: unknown) {
	const oldValue = readRaw(key);
	try {
		localStorage.setItem(GM_STORAGE_PREFIX + key, JSON.stringify(value));
	} catch {
		// 忽略存储失败（容量/隐私模式），通知链照常
	}
	state.mirror.set(key, value);
	// 1. 本 frame 同步分发（remote=false）
	dispatchLocal(key, oldValue, value, false);
	// 2. 同源 frame 经 BroadcastChannel（remote=true）
	try {
		state.bc ??= new BroadcastChannel(BROADCAST_CHANNEL_NAME);
		state.bc?.postMessage({ key, value });
	} catch {
		// BroadcastChannel 不可用时同源通知降级为仅本 frame
	}
	// 3. 跨源 frame 经 server 中继（先写值镜像、再 remote=true 通知）
	if (isMCPMode()) {
		window.__mcpEvent?.('storage', { key, value, gen: window.__OCS_MCP_BRIDGE__?.gen });
	}
}

function dispatchLocal(key: string, oldValue: unknown, newValue: unknown, remote: boolean) {
	for (const { key: k, listener } of state.listeners.values()) {
		if (k === key) {
			try {
				listener(key, oldValue, newValue, remote);
			} catch (e) {
				console.warn('[gm-shim] listener error', e);
			}
		}
	}
}

function removeRaw(key: string) {
	const oldValue = readRaw(key);
	try {
		localStorage.removeItem(GM_STORAGE_PREFIX + key);
	} catch {
		// 忽略
	}
	state.mirror.delete(key);
	dispatchLocal(key, oldValue, undefined, false);
	try {
		state.bc ??= new BroadcastChannel(BROADCAST_CHANNEL_NAME);
		state.bc?.postMessage({ key, value: undefined });
	} catch {
		// 忽略
	}
	if (isMCPMode()) {
		window.__mcpEvent?.('storage', { key, value: undefined, gen: window.__OCS_MCP_BRIDGE__?.gen });
	}
}

function listKeys(): string[] {
	const keys = new Set<string>();
	try {
		for (let i = 0; i < localStorage.length; i++) {
			const k = localStorage.key(i);
			if (k?.startsWith(GM_STORAGE_PREFIX)) keys.add(k.slice(GM_STORAGE_PREFIX.length));
		}
	} catch {
		// 忽略
	}
	for (const k of state.mirror.keys()) keys.add(k);
	return Array.from(keys);
}

/** 安装 GM_* 全局（bootstrap 阶段调用，先于框架 bundle 执行） */
export function installGMShim() {
	const g = globalThis as unknown as Record<string, unknown>;

	g.GM_setValue = (name: string, value: unknown) => writeRaw(name, value);
	g.GM_getValue = (name: string, defaultValue?: unknown) => {
		const v = readRaw(name);
		return v === undefined ? defaultValue : v;
	};
	g.GM_deleteValue = (name: string) => removeRaw(name);
	g.GM_listValues = () => listKeys();

	g.GM_addValueChangeListener = (name: string, listener: ValueChangeListener) => {
		const id = state.nextListenerId++;
		state.listeners.set(id, { key: name, listener });
		return id;
	};
	g.GM_removeValueChangeListener = (id: number) => {
		state.listeners.delete(id);
	};

	// tab API：单标签页直通（cx 闯关计数、easy-us cors 的 TAB_UID 读取依赖）。
	// 契约与 easy-us GMStoreProvider / Tampermonkey 一致：GM_getTab(callback) 回调整个 tab 对象，
	// GM_saveTab(obj) 保存整个对象；localStorage 加前缀承载。
	g.GM_getTab = (callback: (tab: Record<string, unknown>) => void) => {
		let tab: Record<string, unknown> = {};
		try {
			const raw = localStorage.getItem(GM_TAB_PREFIX + 'tab');
			if (raw !== null) tab = JSON.parse(raw);
		} catch {
			// 损坏数据按空 tab 处理
		}
		callback(tab);
	};
	g.GM_saveTab = (tab: Record<string, unknown>) => {
		try {
			localStorage.setItem(GM_TAB_PREFIX + 'tab', JSON.stringify(tab ?? {}));
		} catch {
			// 忽略
		}
	};

	g.GM_notification = (options: unknown) => {
		const text = typeof options === 'string' ? options : String((options as { text?: unknown })?.text ?? '');
		window.__mcpEvent?.('log', { level: 'notify', message: text, gen: window.__OCS_MCP_BRIDGE__?.gen });
	};

	// 不做页面侧假实现（ADR-0019）：图片下载走 server（context.request 共享 cookie）。
	// 提供立即失败的错误桩，防止调用方（如 imageToBase64 回退链）静默挂起。
	g.GM_xmlhttpRequest = (options: { onerror?: (e: unknown) => void }) => {
		const err = new Error('GM_xmlhttpRequest 在 MCP 模式不可用（跨域请求由 server 承担）');
		console.warn('[gm-shim]', err.message);
		options?.onerror?.(err);
		return { abort: () => undefined };
	};

	// 最小 GM_info（entry 与 $gm.isInGMContext 依赖）
	g.GM_info = {
		scriptHandler: 'mcp-xxt',
		version: '1.0.0',
		script: { version: '5.2.3-mcp', name: 'OCS (MCP mode)' }
	};

	// 主世界注入：unsafeWindow 即 window
	g.unsafeWindow = window;

	// 接收同源广播（remote=true）
	try {
		state.bc = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
		state.bc.onmessage = (ev: MessageEvent) => {
			const { key, value } = ev.data as { key: string; value: unknown };
			const oldValue = readRaw(key);
			state.mirror.set(key, value);
			dispatchLocal(key, oldValue, value, true);
		};
	} catch {
		// 忽略
	}

	// 跨源镜像写入入口（server 中继下发：先写值镜像、再 remote=true 通知）
	g.__OCS_GM_RELAY__ = (key: string, value: unknown) => {
		const oldValue = readRaw(key);
		state.mirror.set(key, value);
		dispatchLocal(key, oldValue, value, true);
	};
}
