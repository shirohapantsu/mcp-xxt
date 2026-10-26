/**
 * frame 本地桥（F2，ADR-0017）：每 frame 注册单例 `window.__OCS_MCP_BRIDGE__`。
 *
 * - 上行：`window.__mcpEvent(type, payload)`（server 经 exposeBinding 注入，全 frame 可用，
 *   跨域壳下不依赖 window.top；同源 top 访问仅为优化）；
 * - 下行：server 经 frame.evaluate 调用 `_onDownlink(msg)`——回填答案、下发 deadline/取消 signal、
 *   绑定 run、提交指令、存储中继；
 * - 题目队列：Promise 本地维护（入队 → await 回填/超时/取消）；run 绑定与 document 代次在此管理。
 */

import { isMCPMode } from './mode';

declare global {
	interface Window {
		__mcpEvent?: (type: string, payload: Record<string, unknown>) => Promise<unknown>;
		// eslint-disable-next-line no-var
		__OCS_MCP_BRIDGE__?: MCPBridge;
		// eslint-disable-next-line no-var
		__OCS_GM_RELAY__?: (key: string, value: unknown) => void;
	}
}

export type MCPQuestionType = 'single' | 'multiple' | 'judgement' | 'completion' | 'line' | 'fill' | 'reader' | string;

export interface MCPQuestionInfo {
	id: string;
	type: MCPQuestionType;
	title: string;
	options?: string[];
	images?: string[];
	blankCount?: number;
}

type QuestionStatus = 'pending' | 'answered' | 'skipped' | 'timeout' | 'cancelled' | 'unsupported';

export type QuestionResolution = { id: string; answer: string | null; status: QuestionStatus };

interface PendingQuestion {
	info: MCPQuestionInfo;
	status: QuestionStatus;
	answer: string | null;
	deadline: number;
	resolve: (r: QuestionResolution) => void;
	resultEmitted: boolean;
	timer?: ReturnType<typeof setInterval>;
}

export type SubmitMode = 'temporary' | 'confirm';

/** 提交开始时固定身份，异步执行完成后不能读取可变的 currentRun。 */
export interface SubmitCommand {
	mode: SubmitMode;
	runId: string;
	sessionId: string | null;
	gen: string;
	attemptId: string;
}

export interface MCPBridge {
	gen: string;
	/** 当前绑定的 run（work-detected 确认制回执 / start_work bind-run 下发） */
	currentRun: { runId: string; sessionId: string | null } | null;
	/** 手动模式：commonWork 注册的外部启动器（start_work 下发 start-manual 触发） */
	registerManualWork: (start: () => Promise<void>) => void;
	/** 手动模式能力（惰性 provider：查询时实时求值——页面脚本懒加载，快照会过早取到 false） */
	setManualCapabilities: (provider: () => { auto_save: boolean; auto_submit: boolean }) => void;
	getCapabilities: () => { auto_save: boolean; auto_submit: boolean } | null;
	/** 题目入队（MCP answerer 调用）：发出 question 事件并 await 回填/超时/取消 */
	enqueueQuestion: (info: Omit<MCPQuestionInfo, 'id'>) => Promise<QuestionResolution>;
	/** 不支持的题型直接注册为终态（v1 连线/完形/阅读跳过不改 DOM） */
	registerUnsupportedQuestion: (info: Omit<MCPQuestionInfo, 'id'>) => Promise<QuestionResolution>;
	/** 逐题应用结果（onResultsUpdate 接入点）：applied / applied-failed / timeout / skipped / unsupported */
	emitQuestionResult: (questionId: string, status: string, detail?: string, finish?: boolean) => void;
	/** 整卷作答结束（doWork 完成点，带 frame 代次） */
	emitWorkCompleted: () => void;
	/** 章节测验提交等待（uploadHandler 接入点）：阻塞至 server 下发提交指令或取消 */
	waitSubmitCommand: () => Promise<SubmitCommand | { cancelled: true }>;
	/** 提交回执（可等待：binding 被服务端处理完成才 resolve，避免页面 reload 竞态丢回执） */
	sendSubmitResult: (command: SubmitCommand, ok: boolean, evidence: string, uncertain?: boolean) => Promise<unknown>;
	/** readResult 核验：页面侧状态探测（由具体场景 adapter 经 registerResultProbe 注册） */
	registerResultProbe: (probe: () => Record<string, unknown>) => void;
	/** work-detected 确认制：server 建 run 并经 binding 返回值回执后，本 frame 才注册题目 */
	notifyWorkDetected: (
		payload: Record<string, unknown>
	) => Promise<{ ok: boolean; run_id?: string; session_id?: string; reason?: string }>;
	/** 通用上行（log / course-finished / traversal-blocked / page-invalid 等） */
	notify: (type: string, payload?: Record<string, unknown>) => Promise<unknown>;
	/** 供 server 下行调用（evaluate 目标） */
	_onDownlink: (msg: Record<string, unknown>) => void;
	/** 取消所有等待（abort_run / frame 分离） */
	cancelAll: (reason: string) => void;
}

/** 页面侧默认 deadline（server 下发权威值后覆盖）：从题目入队起计时（ADR-0019 §5） */
const PAGE_DEFAULT_DEADLINE_MS = 300_000;

function uuid(): string {
	if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
	return 'q-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
}

class BridgeImpl implements MCPBridge {
	gen = uuid();
	currentRun: { runId: string; sessionId: string | null } | null = null;

	private pending = new Map<string, PendingQuestion>();
	private manualWork: (() => Promise<void>) | null = null;
	private manualCapabilities: (() => { auto_save: boolean; auto_submit: boolean }) | null = null;
	private submitWaiter: { resolve: (r: SubmitCommand | { cancelled: true }) => void } | null = null;
	private resultProbe: (() => Record<string, unknown>) | null = null;

	notify = (type: string, payload: Record<string, unknown> = {}) => {
		const fn = window.__mcpEvent;
		if (!fn) {
			console.warn('[mcp-bridge] __mcpEvent 不存在（server 未注入绑定），事件丢失:', type);
			return Promise.resolve(undefined);
		}
		return fn(type, { gen: this.gen, ...payload });
	};

	notifyWorkDetected = async (payload: Record<string, unknown>) => {
		const ack = (await this.notify('work-detected', payload)) as
			| { ok: boolean; run_id?: string; session_id?: string; reason?: string }
			| undefined;
		if (ack?.ok && ack.run_id) {
			this.currentRun = { runId: ack.run_id, sessionId: ack.session_id ?? null };
		}
		return ack ?? { ok: false, reason: 'work-detected 无回执' };
	};

	registerManualWork = (start: () => Promise<void>) => {
		this.manualWork = start;
	};

	setManualCapabilities = (provider: () => { auto_save: boolean; auto_submit: boolean }) => {
		this.manualCapabilities = provider;
	};

	getCapabilities = () => {
		try {
			return this.manualCapabilities?.() ?? null;
		} catch {
			return null;
		}
	};

	registerResultProbe = (probe: () => Record<string, unknown>) => {
		this.resultProbe = probe;
	};

	enqueueQuestion = (info: Omit<MCPQuestionInfo, 'id'>) => {
		return new Promise<QuestionResolution>((resolve) => {
			const id = uuid();
			const entry: PendingQuestion = {
				info: { ...info, id },
				status: 'pending',
				answer: null,
				deadline: Date.now() + PAGE_DEFAULT_DEADLINE_MS,
				resolve,
				resultEmitted: false
			};
			this.pending.set(id, entry);
			this.notify('question', {
				run_id: this.currentRun?.runId,
				session_id: this.currentRun?.sessionId,
				question: entry.info
			});
			// deadline 竞速（server 权威 deadline 下发后覆盖 entry.deadline；ADR-0016 单一计时源）
			entry.timer = setInterval(() => {
				if (entry.status === 'pending' && Date.now() >= entry.deadline) {
					entry.status = 'timeout';
					resolve({ id, answer: null, status: 'timeout' });
				}
			}, 250);
		});
	};

	registerUnsupportedQuestion = (info: Omit<MCPQuestionInfo, 'id'>) => {
		return new Promise<QuestionResolution>((resolve) => {
			const id = uuid();
			const entry: PendingQuestion = {
				info: { ...info, id },
				status: 'unsupported',
				answer: null,
				deadline: Date.now(),
				resolve,
				resultEmitted: false
			};
			this.pending.set(id, entry);
			this.notify('question', {
				run_id: this.currentRun?.runId,
				session_id: this.currentRun?.sessionId,
				question: entry.info,
				status: 'unsupported'
			});
			resolve({ id, answer: null, status: 'unsupported' });
		});
	};

	emitQuestionResult = (questionId: string, status: string, detail?: string, finish?: boolean) => {
		const entry = this.pending.get(questionId);
		if (!entry || entry.resultEmitted) return;
		entry.resultEmitted = true;
		if (entry.timer) clearInterval(entry.timer);
		this.notify('question-result', {
			run_id: this.currentRun?.runId,
			session_id: this.currentRun?.sessionId,
			question_id: questionId,
			status,
			detail,
			finish
		});
		this.pending.delete(questionId);
	};

	emitWorkCompleted = () => {
		this.notify('work-completed', {
			run_id: this.currentRun?.runId,
			session_id: this.currentRun?.sessionId,
			gen: this.gen
		});
	};

	waitSubmitCommand = () => {
		return new Promise<SubmitCommand | { cancelled: true }>((resolve) => {
			this.submitWaiter = { resolve };
		});
	};

	sendSubmitResult = (command: SubmitCommand, ok: boolean, evidence: string, uncertain = false) => {
		return this.notify('submit-result', {
			run_id: command.runId,
			session_id: command.sessionId,
			gen: command.gen,
			attempt_id: command.attemptId,
			mode: command.mode,
			uncertain,
			ok,
			evidence
		});
	};

	cancelAll = (reason: string) => {
		for (const entry of this.pending.values()) {
			if (entry.status === 'pending') {
				entry.status = 'cancelled';
				entry.resolve({ id: entry.info.id, answer: null, status: 'cancelled' });
			}
			if (entry.timer) clearInterval(entry.timer);
		}
		this.pending.clear();
		this.submitWaiter?.resolve({ cancelled: true });
		this.submitWaiter = null;
		console.warn('[mcp-bridge] cancelAll:', reason);
	};

	_onDownlink = (msg: Record<string, unknown>) => {
		const kind = String(msg.kind ?? '');
		switch (kind) {
			case 'ping':
				break;
			case 'bind-run':
				this.currentRun = { runId: String(msg.run_id), sessionId: (msg.session_id as string | null) ?? null };
				break;
			case 'start-manual':
				this.manualWork?.().catch((e) => console.error('[mcp-bridge] manual start error', e));
				break;
			case 'deadline': {
				const entry = this.pending.get(String(msg.question_id));
				if (entry) entry.deadline = Number(msg.deadline);
				break;
			}
			case 'answer': {
				const id = String(msg.question_id);
				const entry = this.pending.get(id);
				if (!entry || entry.status !== 'pending') break;
				if (msg.answer === null || msg.answer === undefined) {
					entry.status = 'skipped';
					entry.resolve({ id, answer: null, status: 'skipped' });
				} else {
					entry.status = 'answered';
					entry.answer = String(msg.answer);
					entry.resolve({ id, answer: entry.answer, status: 'answered' });
				}
				break;
			}
			case 'cancel':
				this.cancelAll(String(msg.reason ?? 'cancelled'));
				break;
			case 'submit': {
				const binding = this.currentRun;
				if (!binding || msg.run_id !== binding.runId || typeof msg.attempt_id !== 'string') break;
				const mode = msg.mode === 'confirm' ? 'confirm' : 'temporary';
				this.submitWaiter?.resolve({
					mode,
					runId: binding.runId,
					sessionId: binding.sessionId,
					gen: this.gen,
					attemptId: msg.attempt_id
				});
				this.submitWaiter = null;
				break;
			}
			case 'read-result': {
				if (msg.run_id !== this.currentRun?.runId) break;
				let probeResult: Record<string, unknown>;
				try {
					probeResult = this.resultProbe?.() ?? {};
				} catch (error) {
					probeResult = { saved: false, submitted: false, error: String(error) };
				}
				this.notify('read-result', {
					...probeResult,
					run_id: this.currentRun?.runId,
					session_id: this.currentRun?.sessionId,
					attempt_id: msg.attempt_id
				});
				break;
			}
			case 'relay-storage': {
				// 跨源中继：先写值镜像、再以 remote=true 通知（ADR-0021 §1）
				window.__OCS_GM_RELAY__?.(String(msg.key), msg.value);
				break;
			}
			case 'storage-snapshot': {
				const entries = (msg.entries ?? []) as [string, unknown][];
				for (const [key, value] of entries) {
					window.__OCS_GM_RELAY__?.(key, value);
				}
				break;
			}
			default:
				console.warn('[mcp-bridge] unknown downlink kind:', kind);
		}
	};
}

/** bootstrap 阶段调用：幂等，重复注入不重建（F8/F1 幂等要求） */
export function installBridge(): MCPBridge {
	if (window.__OCS_MCP_BRIDGE__) {
		return window.__OCS_MCP_BRIDGE__;
	}
	const bridge = new BridgeImpl();
	window.__OCS_MCP_BRIDGE__ = bridge;
	return bridge;
}

export function getBridge(): MCPBridge | undefined {
	if (!isMCPMode()) return undefined;
	return window.__OCS_MCP_BRIDGE__;
}
