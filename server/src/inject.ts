/**
 * 事件协议层（ADR-0017/0020/0021）：
 * - 上行：__mcpEvent 绑定回调分发（work-detected 确认制回执、题目注册、逐题结果、提交回执、
 *   存储中继、hello/代次追踪）
 * - 下行：frame.evaluate 调用 frame 本地桥（回填答案 / deadline / 取消 signal / 提交指令 /
 *   存储镜像与快照）
 */

import { Frame, Page } from 'playwright';
import { BrowserHost, courseIdentityFromUrl } from './browser.js';
import { McpToolError, RunManager, WorkDetectedAck } from './run-manager.js';
import { ManagedQuestion } from './types.js';
import { log } from './log.js';

export type DownlinkMessage =
	| { kind: 'ping' }
	| { kind: 'bind-run'; run_id: string; session_id: string | null }
	| { kind: 'start-manual' }
	| { kind: 'deadline'; question_id: string; deadline: number }
	| { kind: 'answer'; question_id: string; answer: string | null }
	| { kind: 'cancel'; reason: string }
	| { kind: 'submit'; mode: 'temporary' | 'confirm'; run_id: string; attempt_id: string }
	| { kind: 'read-result'; run_id: string; attempt_id: string }
	| { kind: 'relay-storage'; key: string; value: unknown }
	| { kind: 'storage-snapshot'; entries: [string, unknown][] };

interface RunFrameRef {
	pageKey: string;
	frame: Frame;
	url: string;
	gen: string;
}

export class EventRouter {
	/** runId → frame 引用（下行 evaluate 目标） */
	private runFrames = new Map<string, RunFrameRef>();
	/** 等待页面 submit-result / read-result 的解析器 */
	private submitWaiters = new Map<string, (r: { ok: boolean; evidence: string; uncertain: boolean }) => void>();
	private readResultWaiters = new Map<string, (r: Record<string, unknown>) => void>();

	constructor(private browser: BrowserHost, private rm: RunManager) {}

	// ---------- 上行 ----------

	async onEvent(args: { page: Page; frame: Frame; type: string; payload: Record<string, unknown> }): Promise<unknown> {
		const { page, frame, type, payload } = args;
		const pageKey = this.browser.getPageKey(page);
		const frameUrl = frame.url();
		const gen = String(payload.gen ?? '');

		switch (type) {
			case 'hello':
				return this.onHello(pageKey, frame, frameUrl, gen);

			case 'storage': {
				const key = String(payload.key ?? '');
				this.rm.setStorageMirror(key, payload.value);
				await this.relayStorage(frame, key, payload.value);
				return { ok: true };
			}

			case 'log':
				log.info(`[page${pageKey}] ${String(payload.level ?? 'log')}: ${String(payload.message ?? '')}`);
				return { ok: true };

			case 'work-detected':
				return this.onWorkDetected(pageKey, page.url(), frame, frameUrl, gen, payload);

			case 'question':
				return this.onQuestion(payload);

			case 'question-result': {
				const runId = String(payload.run_id ?? '');
				this.rm.applyQuestionResult(
					runId,
					String(payload.question_id ?? ''),
					payload.status as ManagedQuestion['status'],
					typeof payload.detail === 'string' ? payload.detail : undefined,
					typeof payload.finish === 'boolean' ? payload.finish : undefined
				);
				return { ok: true };
			}

			case 'work-completed': {
				const runId = String(payload.run_id ?? '');
				this.rm.markWorkCompleted(runId, String(payload.gen ?? ''));
				return { ok: true };
			}

			case 'submit-result': {
				const runId = String(payload.run_id ?? '');
				if (!this.matchesAttempt(runId, pageKey, frame, gen, payload))
					return { ok: false, reason: 'stale submit-result' };
				const mode = payload.mode === 'confirm' ? 'confirm' : 'temporary';
				const ok = payload.ok === true;
				const evidence = String(payload.evidence ?? '');
				const uncertain = payload.uncertain === true;
				if (!uncertain) this.rm.applySubmitResult(runId, mode, ok, evidence);
				this.submitWaiters.get(runId)?.({ ok, evidence, uncertain });
				this.submitWaiters.delete(runId);
				return { ok: true };
			}

			case 'read-result': {
				const runId = String(payload.run_id ?? '');
				if (!this.matchesAttempt(runId, pageKey, frame, gen, payload))
					return { ok: false, reason: 'stale read-result' };
				this.readResultWaiters.get(runId)?.(payload);
				this.readResultWaiters.delete(runId);
				return { ok: true };
			}

			case 'course-finished':
			case 'traversal-blocked':
			case 'page-invalid': {
				const session = this.sessionForPage(pageKey, page.url(), payload);
				if (!session) return this.unboundTraversalEvent(type, pageKey, frameUrl, gen);
				this.rm.emitEvent(session, null, type, { reason: String(payload.reason ?? '') }, { url: frameUrl, gen });
				return { ok: true };
			}

			default:
				log.warn(`[inject] unknown event type: ${type}`);
				return { ok: false, reason: 'unknown type' };
		}
	}

	private sessionForPage(pageKey: string, pageUrl: string, payload: Record<string, unknown>) {
		const current = this.rm.getCurrentSession();
		// 带旧 session_id 的迟到事件不能影响重开的课程。
		if (payload.session_id && payload.session_id !== current?.id) return undefined;
		return this.rm.resolveSessionPage(pageKey, courseIdentityFromUrl(pageUrl));
	}

	private unboundTraversalEvent(type: string, pageKey: string, frameUrl: string, gen: string): WorkDetectedAck {
		const session = this.rm.getCurrentSession();
		const reason = `遍历事件 ${type} 无法关联课程会话（page=${pageKey}, session=${session?.id ?? 'none'}, sessionPage=${
			session?.pageKey ?? 'none'
		}）。`;
		log.warn(`[traversal] ${reason} frame=${frameUrl} gen=${gen}`);
		return { ok: false, reason };
	}

	private matchesAttempt(
		runId: string,
		pageKey: string,
		frame: Frame,
		gen: string,
		payload: Record<string, unknown>
	): boolean {
		const ref = this.runFrames.get(runId);
		const run = this.rm.getRun(runId);
		return !!(
			ref &&
			run &&
			ref.frame === frame &&
			ref.pageKey === pageKey &&
			ref.gen === gen &&
			run.frameGen === gen &&
			run.submitAttemptId &&
			payload.attempt_id === run.submitAttemptId &&
			(payload.session_id ?? null) === run.sessionId
		);
	}

	private async onHello(pageKey: string, frame: Frame, frameUrl: string, gen: string) {
		// frame 重生：绑定该 frame 的未终态 run → aborted（frame 分离）
		if (
			Array.from(this.runFrames.values()).some(
				(ref) => ref.pageKey === pageKey && ref.frame === frame && ref.gen !== gen
			)
		) {
			// 旧文档的 hello 也可能迟到，不能用它使后继文档失效。
			const liveGen = await frame
				.evaluate(() => (window as unknown as { __OCS_MCP_BRIDGE__?: { gen: string } }).__OCS_MCP_BRIDGE__?.gen)
				.catch(() => undefined);
			if (liveGen !== gen) return { ok: false, reason: 'stale hello' };
		}
		for (const [runId, ref] of this.runFrames) {
			if (ref.pageKey === pageKey && ref.frame === frame && ref.gen !== gen) {
				this.rm.handleRunFrameLost(runId, pageKey, ref.gen);
			}
		}
		// 存储快照下发（跨源 frame 初值同步；同源 frame localStorage 已有值，合并无害）
		const entries = this.rm.getStorageMirror();
		if (entries.length > 0) {
			await this.sendToFrame(pageKey, frameUrl, gen, { kind: 'storage-snapshot', entries }).catch(() => undefined);
		}
		return { ok: true };
	}

	private onWorkDetected(
		pageKey: string,
		pageUrl: string,
		frame: Frame,
		frameUrl: string,
		gen: string,
		payload: Record<string, unknown>
	): WorkDetectedAck {
		const session = this.sessionForPage(pageKey, pageUrl, payload);
		if (!session) return this.unboundTraversalEvent('work-detected', pageKey, frameUrl, gen);
		const identity = (payload.identity ?? {}) as Record<string, string>;
		const ack = this.rm.handleWorkDetected({
			pageKey,
			sessionId: session?.id ?? null,
			frameUrl,
			frameGen: gen,
			payload: {
				identity: {
					courseId: identity.courseId,
					clazzId: identity.clazzId,
					chapterId: identity.chapterId,
					jobId: identity.jobId
				},
				jobName: typeof payload.jobName === 'string' ? payload.jobName : undefined,
				href: typeof payload.href === 'string' ? payload.href : frameUrl
			}
		});
		if (ack.ok && ack.run_id) {
			this.runFrames.set(ack.run_id, { pageKey, frame, url: frameUrl, gen });
		}
		return ack;
	}

	private async onQuestion(payload: Record<string, unknown>) {
		const runId = String(payload.run_id ?? '');
		const q = (payload.question ?? {}) as Record<string, unknown>;
		const mq = this.rm.registerQuestion(runId, {
			id: String(q.id ?? ''),
			type: String(q.type ?? 'unknown') as ManagedQuestion['type'],
			title: String(q.title ?? ''),
			options: Array.isArray(q.options) ? (q.options as string[]) : undefined,
			images: Array.isArray(q.images) ? (q.images as string[]) : undefined,
			blankCount: typeof q.blankCount === 'number' ? q.blankCount : undefined
		});
		// 权威 deadline 下发（ADR-0016：server 是唯一计时源）
		await this.sendToRun(runId, { kind: 'deadline', question_id: mq.id, deadline: mq.deadline }).catch((err) =>
			log.warn(`[inject] deadline push failed: ${err}`)
		);
		return { ok: true };
	}

	// ---------- 下行 ----------

	private async sendToFrame(pageKey: string, frameUrl: string, gen: string, msg: DownlinkMessage) {
		const frames = this.browser.getFrames(pageKey).filter((f) => f.gen === gen);
		const target = frames.find((f) => f.url === frameUrl) ?? frames[0];
		if (!target) throw new McpToolError(`目标 frame 不可达（${frameUrl}，gen=${gen}）。`);
		await target.frame.evaluate((m) => {
			const bridge = (window as unknown as { __OCS_MCP_BRIDGE__?: { _onDownlink: (m: unknown) => void } })
				.__OCS_MCP_BRIDGE__;
			if (!bridge) throw new Error('MCP bridge 不存在（bundle 未注入或已失效）');
			bridge._onDownlink(m);
		}, msg);
	}

	/** 向 run 绑定的 frame 下发指令 */
	async sendToRun(runId: string, msg: DownlinkMessage) {
		const ref = this.runFrames.get(runId);
		if (!ref) throw new McpToolError(`run ${runId} 没有可用的 frame 引用。`);
		try {
			await ref.frame.evaluate(
				({ msg: m, gen, runId }) => {
					const bridge = (
						window as unknown as {
							__OCS_MCP_BRIDGE__?: {
								gen: string;
								currentRun?: { runId: string } | null;
								_onDownlink: (m: unknown) => void;
							};
						}
					).__OCS_MCP_BRIDGE__;
					if (!bridge) throw new Error('MCP bridge 不存在（bundle 未注入或已失效）');
					if (bridge.gen !== gen || (m.kind !== 'bind-run' && bridge.currentRun?.runId !== runId)) {
						throw new Error('MCP bridge 已更换 document 或 run');
					}
					bridge._onDownlink(m);
				},
				{ msg, gen: ref.gen, runId }
			);
		} catch (err) {
			// frame 分离：绑定该 run 的未终态 run → aborted
			this.rm.handleRunFrameLost(runId, ref.pageKey, ref.gen);
			throw new McpToolError(`下行指令失败（frame 可能已分离/导航）：${String(err)}`);
		}
	}

	async pushBindRun(runId: string, sessionId: string | null, frame: Frame) {
		const run = this.rm.getRun(runId);
		if (!run) throw new McpToolError(`run ${runId} 不存在。`);
		// 手动入口可能尚未注册 capabilities，不能把其临时代次当作真实 document 代次。
		const gen = await frame.evaluate(
			() => (window as unknown as { __OCS_MCP_BRIDGE__?: { gen: string } }).__OCS_MCP_BRIDGE__?.gen
		);
		if (!gen) throw new McpToolError('MCP bridge 不存在，无法绑定 run。');
		run.frameGen = gen;
		this.runFrames.set(runId, { pageKey: run.pageKey, frame, url: frame.url(), gen: run.frameGen });
		await this.sendToRun(runId, { kind: 'bind-run', run_id: runId, session_id: sessionId });
	}

	async pushStartManual(runId: string) {
		await this.sendToRun(runId, { kind: 'start-manual' });
	}

	async pushAnswer(runId: string, questionId: string, encoded: string | null) {
		await this.sendToRun(runId, { kind: 'answer', question_id: questionId, answer: encoded });
	}

	async pushCancel(runId: string, reason: string) {
		await this.sendToRun(runId, { kind: 'cancel', reason }).catch((err) =>
			log.warn(`[inject] cancel push failed: ${err}`)
		);
	}

	/** 等待者与计时器属于单次请求；成功、失败和超时都必须清理。 */
	private async requestResult<T>(
		runId: string,
		msg: DownlinkMessage,
		waiters: Map<string, (result: T) => void>,
		timeoutMs: number
	): Promise<T | null> {
		let resolveResult!: (result: T | null) => void;
		const result = new Promise<T | null>((resolve) => {
			resolveResult = resolve;
		});
		const waiter = (value: T) => resolveResult(value);
		waiters.set(runId, waiter);
		const timer = setTimeout(() => resolveResult(null), timeoutMs);
		try {
			await this.sendToRun(runId, msg);
			return await result;
		} finally {
			clearTimeout(timer);
			if (waiters.get(runId) === waiter) waiters.delete(runId);
		}
	}

	/** submit_paper：下发提交指令并等待本次尝试的页面回执。 */
	async sendSubmit(
		runId: string,
		mode: 'temporary' | 'confirm',
		timeoutMs = 45_000
	): Promise<{ ok: boolean; evidence: string; timedOut: boolean }> {
		const attemptId = this.rm.getRun(runId)?.submitAttemptId;
		if (!attemptId) throw new McpToolError('提交尝试尚未建立。');
		const result = await this.requestResult(
			runId,
			{ kind: 'submit', mode, run_id: runId, attempt_id: attemptId },
			this.submitWaiters,
			timeoutMs
		);
		return result
			? { ok: result.ok, evidence: result.evidence, timedOut: result.uncertain }
			: {
					ok: false,
					evidence: `提交指令在 ${timeoutMs}ms 内未收到页面回执`,
					timedOut: true
			  };
	}

	/** readResult 核验（提交结果不确定时） */
	async readResult(runId: string, timeoutMs = 15_000): Promise<Record<string, unknown> | null> {
		const attemptId = this.rm.getRun(runId)?.submitAttemptId;
		if (!attemptId) return null;
		return this.requestResult(
			runId,
			{ kind: 'read-result', run_id: runId, attempt_id: attemptId },
			this.readResultWaiters,
			timeoutMs
		);
	}

	// ---------- 跨源存储中继（D16 / ADR-0021 §1） ----------

	/**
	 * 存储 事件来自 frame F：同源 frame 已由 BroadcastChannel 覆盖；
	 * 跨源 frame 经 server 中继 —— 先在接收端写入值镜像、再以 remote=true 通知。
	 */
	private async relayStorage(sender: Frame, key: string, value: unknown) {
		let senderOrigin = '';
		try {
			senderOrigin = new URL(sender.url()).origin;
		} catch {
			return;
		}
		const pages = this.browser.listPages();
		for (const page of pages) {
			const pageKey = this.browser.getPageKey(page);
			for (const ref of this.browser.getFrames(pageKey)) {
				if (ref.frame === sender) continue;
				let origin = '';
				try {
					origin = new URL(ref.url).origin;
				} catch {
					continue;
				}
				if (origin === senderOrigin) continue; // 同源：BroadcastChannel 已覆盖
				await ref.frame
					.evaluate(
						(m) => {
							const bridge = (window as unknown as { __OCS_MCP_BRIDGE__?: { _onDownlink: (m: unknown) => void } })
								.__OCS_MCP_BRIDGE__;
							bridge?._onDownlink(m);
						},
						{ kind: 'relay-storage', key, value }
					)
					.catch(() => undefined);
			}
		}
	}

	/** 手动模式：start_work 的下行目标 frame（页面主 frame） */
	mainFrameRef(page: Page): Frame {
		return page.mainFrame();
	}

	/**
	 * 查询页面侧保存/提交能力（F10 扩展）：作业页脚本加载时经 mcpRegisterSubmitCapabilities
	 * 注册到 frame 桥；bundle 未注入或尚未注册时返回 null。
	 */
	async queryFrameCapabilities(page: Page): Promise<{ auto_save: boolean; auto_submit: boolean; gen: string } | null> {
		const result = await page
			.mainFrame()
			.evaluate<{ hasBridge: boolean; caps: { auto_save: boolean; auto_submit: boolean } | null; gen: string }>(
				// IIFE 表达式：Playwright 对多行箭头字符串按表达式求值会返回函数本身而非调用结果
				`(() => {
					const b = window.__OCS_MCP_BRIDGE__;
					return {
						hasBridge: !!b,
						caps: b && typeof b.getCapabilities === 'function' ? b.getCapabilities() : null,
						gen: b?.gen ?? ''
					};
				})()`
			)
			.catch((err) => {
				log.warn(`[caps] evaluate 失败: ${err}`);
				return null;
			});
		if (!result || !result.caps) return null;
		return { ...result.caps, gen: result.gen };
	}
}
