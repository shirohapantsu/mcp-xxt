/**
 * run-manager：权威 run 状态机 + 事件信封/游标 + 单 run 互斥 + 章节重进计数（ADR-0017/0020/0021）
 *
 * - 状态机：running → ready_for_review → saving→saved(→saved-and-left) / submitting→finished；
 *   saving 失败退回 ready_for_review；abort_run → released/aborted（终态）。
 * - ready_for_review 唯一迁移依据：全部题目到达终态 且 收到 work-completed。
 * - 事件：per-session 单调 event_id；wait_next_work 按游标每事件至多投递一次；
 *   request_id 缓存已投递响应（客户端超时重试不跳过事件）。
 * - 单活跃 run 互斥：存在未终态 run 时 start_work / work-detected 报错。
 * - 重进计数：按 course/clazz/chapter/job 身份计数，取得进展即重置；同章节不同测验不累计。
 */

import { randomUUID } from 'node:crypto';
import {
	Envelope,
	ManagedQuestion,
	ManagedRun,
	PageEventType,
	RunIdentity,
	RunStatus,
	DELIVERABLE_EVENT_TYPES,
	QUESTION_DEADLINE_MS,
	isTerminalQuestion,
	isTerminalRun
} from './types.js';
import { log } from './log.js';

export interface WorkDetectedPayload {
	identity: RunIdentity;
	jobName?: string;
	href?: string;
}

/** work-detected 确认制回执 */
export interface WorkDetectedAck {
	ok: boolean;
	run_id?: string;
	session_id?: string;
	reason?: string;
}

export interface WaitNextWorkResponse {
	event: 'work-ready' | 'still-waiting' | 'course-finished' | 'traversal-blocked' | 'page-invalid';
	run_id?: string;
	session_id?: string;
	reason?: string;
}

interface TraversalSession {
	id: string;
	pageKey: string;
	/** 事件历史（含全部类型，供诊断；投递只针对 DELIVERABLE_EVENT_TYPES） */
	events: Envelope[];
	nextEventId: number;
	/** 已投递的最大 event_id（游标：每事件至多投递一次） */
	cursor: number;
	/** wait_next_work 挂起等待者 */
	waiters: Set<(resp: WaitNextWorkResponse) => void>;
	/** request_id → 已投递响应缓存（ADR-0021 §3） */
	requestIdCache: Map<string, WaitNextWorkResponse>;
	terminated: boolean;
	/** 终止事件是否已投递（course-finished / traversal-blocked / page-invalid 只投一次） */
	terminalEventDelivered: boolean;
	createdAt: number;
}

/** 同一身份连续 work-detected 次数达到该值视为闯关受阻（与原页面计数语义一致） */
const REENTRY_BLOCK_THRESHOLD = 3;

export class RunManager {
	private sessions = new Map<string, TraversalSession>();
	private runs = new Map<string, ManagedRun>();
	/** 当前活跃（未终态）run 至多一个（ADR-0013） */
	private activeRunId: string | null = null;
	/** 最近创建的 session（wait_next_work 缺省目标） */
	private currentSessionId: string | null = null;
	/** 页面 → 当前 session */
	private pageSessions = new Map<string, string>();
	/** 重进计数：session 内按身份 */
	private reentryCounters = new Map<string, Map<string, number>>();
	/** 存储镜像：跨源中继与 GM_getValue 兜底（D16/ADR-0021 §1） */
	private storageMirror = new Map<string, unknown>();
	/** 等待页面 submit-result 的挂起提交（submit_paper 阻塞点） */
	private pendingSubmits = new Map<string, { resolve: (r: SubmitPageResult) => void; timer: NodeJS.Timeout }>();

	// ---------- session ----------

	createSession(pageKey: string): TraversalSession {
		// 同一页面重开课程：旧 session 的 waiter 终止、迟到事件忽略（ADR-0021 §3）
		const prev = this.pageSessions.get(pageKey);
		if (prev) {
			this.terminateSession(prev, 'page-invalid', '页面重新导航，遍历会话已由新 session 取代');
		}
		const session: TraversalSession = {
			id: randomUUID(),
			pageKey,
			events: [],
			nextEventId: 1,
			cursor: 0,
			waiters: new Set(),
			requestIdCache: new Map(),
			terminated: false,
			terminalEventDelivered: false,
			createdAt: Date.now()
		};
		this.sessions.set(session.id, session);
		this.pageSessions.set(pageKey, session.id);
		this.currentSessionId = session.id;
		log.info(`[session] created ${session.id} (page=${pageKey})`);
		return session;
	}

	getSession(sessionId: string | null | undefined): TraversalSession | undefined {
		if (!sessionId) return undefined;
		return this.sessions.get(sessionId);
	}

	getCurrentSession(): TraversalSession | undefined {
		return this.currentSessionId ? this.sessions.get(this.currentSessionId) : undefined;
	}

	/** open_page 导航后回填 session 的页面归属（session 在导航前预创建） */
	rebindSessionPage(sessionId: string, pageKey: string) {
		const session = this.sessions.get(sessionId);
		if (!session) return;
		session.pageKey = pageKey;
		this.pageSessions.set(pageKey, sessionId);
		log.info(`[session] ${sessionId} rebound to page ${pageKey}`);
	}

	terminateSession(sessionId: string, type: 'page-invalid' | 'traversal-blocked', reason: string) {
		const session = this.sessions.get(sessionId);
		if (!session || session.terminated) return;
		session.terminated = true;
		this.emitEvent(session, null, type, { reason });
		for (const waiter of session.waiters) {
			waiter({ event: type, reason, session_id: session.id });
		}
		session.waiters.clear();
		log.info(`[session] terminated ${session.id}: ${type} ${reason}`);
	}

	// ---------- 事件 ----------

	/** 追加事件（全部类型入历史）；DELIVERABLE 类型唤醒等待者 */
	emitEvent(
		session: TraversalSession,
		runId: string | null,
		type: PageEventType,
		payload: Record<string, unknown>,
		frame: { url: string; gen: string } = { url: '', gen: '' }
	): Envelope {
		const env: Envelope = {
			eventId: session.nextEventId++,
			sessionId: session.id,
			runId,
			type,
			payload,
			frame,
			ts: Date.now()
		};
		session.events.push(env);
		if (DELIVERABLE_EVENT_TYPES.includes(type)) {
			for (const waiter of Array.from(session.waiters)) {
				const resp = this.deliver(session, env);
				if (resp) {
					session.waiters.delete(waiter);
					waiter(resp);
				}
			}
		}
		return env;
	}

	/**
	 * 尝试把事件按游标投递为一个 wait 响应。
	 * - 已过游标 → 已投递，返回 null；
	 * - 终止事件只投递一次（terminalEventDelivered）；
	 * - work-ready 对应 run 已终态 → 跳过不投（不推进游标，旧事件保持未投递状态）。
	 */
	private deliver(session: TraversalSession, env: Envelope): WaitNextWorkResponse | null {
		if (env.eventId <= session.cursor) return null;
		if (env.type === 'work-detected') {
			const runId = env.runId;
			const run = runId ? this.runs.get(runId) : undefined;
			if (!run) return null;
			if (isTerminalRun(run.status)) {
				return null; // 已结束 run 的旧 work-ready 不抢占下一轮等待
			}
			if (session.terminalEventDelivered) return null;
			session.cursor = env.eventId;
			return { event: 'work-ready', run_id: run.id, session_id: session.id };
		}
		if (env.type === 'course-finished' || env.type === 'traversal-blocked' || env.type === 'page-invalid') {
			if (session.terminalEventDelivered) return null;
			session.terminalEventDelivered = true;
			session.cursor = env.eventId;
			return {
				event: env.type,
				reason: (env.payload.reason as string) ?? undefined,
				session_id: session.id
			};
		}
		return null;
	}

	// ---------- wait_next_work ----------

	async waitNextWork(timeoutMs: number, requestId?: string): Promise<WaitNextWorkResponse> {
		const session = this.getCurrentSession();
		if (!session) {
			return { event: 'page-invalid', reason: '当前没有遍历会话（请先 open_page 课程学习页）' };
		}
		if (requestId) {
			const cached = session.requestIdCache.get(requestId);
			if (cached) {
				log.debug(`[wait] request_id ${requestId} cache hit`);
				return cached;
			}
		}
		// 先读历史（早于调用的事件不丢失），再挂起等待
		const immediate = this.nextDeliverable(session);
		if (immediate) {
			return this.finishWait(session, requestId, immediate);
		}
		if (session.terminated) {
			// 终止事件已投递过（或无新事件）：明确告知，不挂起
			return { event: 'still-waiting', session_id: session.id };
		}
		const resp = await new Promise<WaitNextWorkResponse>((resolve) => {
			let timer: NodeJS.Timeout | undefined;
			const waiter = (r: WaitNextWorkResponse) => {
				if (timer) clearTimeout(timer);
				resolve(r);
			};
			session.waiters.add(waiter);
			timer = setTimeout(() => {
				session.waiters.delete(waiter);
				resolve({ event: 'still-waiting', session_id: session.id });
			}, timeoutMs);
		});
		if (resp.event === 'still-waiting') {
			return resp; // 超时不消耗未交付事件，不缓存
		}
		return this.finishWait(session, requestId, resp);
	}

	/** 扫描历史中下一个可投递事件（游标之后），返回其响应（不推进游标） */
	private nextDeliverable(session: TraversalSession): WaitNextWorkResponse | null {
		for (const env of session.events) {
			if (env.eventId <= session.cursor) continue;
			const resp = this.deliver(session, env);
			if (resp) return resp;
		}
		return null;
	}

	/** 推进游标并缓存响应（仅投递型响应） */
	private finishWait(session: TraversalSession, requestId: string | undefined, resp: WaitNextWorkResponse): WaitNextWorkResponse {
		// deliver() 已推进 cursor；这里仅缓存
		if (requestId && resp.event !== 'still-waiting') {
			session.requestIdCache.set(requestId, resp);
		}
		return resp;
	}

	// ---------- run ----------

	getRun(runId: string | null | undefined): ManagedRun | undefined {
		if (runId) return this.runs.get(runId);
		return this.activeRunId ? this.runs.get(this.activeRunId) : undefined;
	}

	getActiveRun(): ManagedRun | undefined {
		return this.activeRunId ? this.runs.get(this.activeRunId) : undefined;
	}

	/** 手动入口：start_work 创建 run（不经过 work-detected）。capabilities 来自页面侧能力探测 */
	createManualRun(params: {
		pageKey: string;
		frameUrl: string;
		frameGen: string;
		href: string;
		capabilities?: { auto_save: boolean; auto_submit: boolean };
	}): ManagedRun {
		if (this.activeRunId) {
			throw new McpToolError(`已存在活跃 run（${this.activeRunId}），同一时刻最多一个活跃 run；请先 abort_run 或完成 submit_paper。`);
		}
		const run: ManagedRun = {
			id: randomUUID(),
			sessionId: null,
			mode: 'manual',
			pageKey: params.pageKey,
			frameUrl: params.frameUrl,
			frameGen: params.frameGen,
			identity: null,
			status: 'running',
			questions: new Map(),
			// 默认（页面无保存能力/未探测到）：v1 作业到 ready_for_review + 人工保存（D14 分层）
			capabilities: params.capabilities ?? { auto_save: false, auto_submit: false },
			workCompleted: false,
			createdAt: Date.now()
		};
		this.runs.set(run.id, run);
		this.activeRunId = run.id;
		log.info(
			`[run] manual run created ${run.id} (href=${params.href}, caps=${JSON.stringify(run.capabilities)})`
		);
		return run;
	}

	/**
	 * work-detected 确认制（ADR-0017 §2）：创建 run 并回执；互斥/重进计数不通过则拒绝。
	 */
	handleWorkDetected(params: {
		pageKey: string;
		sessionId: string | null;
		frameUrl: string;
		frameGen: string;
		payload: WorkDetectedPayload;
	}): WorkDetectedAck {
		const { pageKey, frameUrl, frameGen, payload } = params;
		const session = params.sessionId ? this.sessions.get(params.sessionId) : undefined;

		if (this.activeRunId) {
			// 确认事件重试去重：同一 frame 的同 identity 活跃 run 直接回执原 run
			const active = this.runs.get(this.activeRunId);
			if (
				active &&
				active.pageKey === pageKey &&
				active.frameGen === frameGen &&
				payload.identity.jobId &&
				active.identity?.jobId === payload.identity.jobId
			) {
				log.info(`[run] work-detected retry dedup: ${active.id}`);
				return { ok: true, run_id: active.id, session_id: active.sessionId ?? undefined };
			}
			return { ok: false, reason: `已存在活跃 run（${this.activeRunId}），同一时刻最多一个活跃 run。` };
		}

		// 重进计数身份化（ADR-0020 §6）：按身份计数，取得进展即重置
		if (session) {
			const key = this.identityKey(payload.identity);
			const counters = this.counterFor(session.id);
			const count = (counters.get(key) ?? 0) + 1;
			counters.set(key, count);
			if (count >= REENTRY_BLOCK_THRESHOLD) {
				const reason = `同一测验（identity=${key}）第 ${count} 次进入仍未取得进展，判定闯关受阻（traversal-blocked）。`;
				this.emitEvent(session, null, 'traversal-blocked', { reason });
				log.warn(`[traversal] ${reason}`);
				return { ok: false, reason };
			}
		}

		const run: ManagedRun = {
			id: randomUUID(),
			sessionId: session?.id ?? null,
			mode: 'course',
			pageKey,
			frameUrl,
			frameGen,
			identity: payload.identity,
			jobName: payload.jobName,
			status: 'running',
			questions: new Map(),
			capabilities: { auto_save: true, auto_submit: true },
			workCompleted: false,
			createdAt: Date.now()
		};
		this.runs.set(run.id, run);
		this.activeRunId = run.id;
		if (session) {
			this.emitEvent(session, run.id, 'work-detected', {
				jobName: payload.jobName,
				identity: payload.identity,
				href: payload.href
			});
		}
		log.info(`[run] course run created ${run.id} (job=${payload.jobName}, identity=${JSON.stringify(payload.identity)})`);
		return { ok: true, run_id: run.id, session_id: session?.id };
	}

	private counterFor(sessionId: string): Map<string, number> {
		let m = this.reentryCounters.get(sessionId);
		if (!m) {
			m = new Map();
			this.reentryCounters.set(sessionId, m);
		}
		return m;
	}

	private identityKey(identity: RunIdentity): string {
		return [identity.courseId, identity.clazzId, identity.chapterId, identity.jobId].map((v) => v ?? '-').join('|');
	}

	/** 取得进展即重置相应身份计数（任一 job 保存/提交完成） */
	private resetReentryCounter(run: ManagedRun) {
		if (!run.sessionId || !run.identity) return;
		const counters = this.reentryCounters.get(run.sessionId);
		const key = this.identityKey(run.identity);
		if (counters?.has(key)) {
			counters.delete(key);
			log.info(`[traversal] reentry counter reset for ${key}`);
		}
	}

	/** 更新 run 能力（页面侧能力注册可能晚于 start_work 查询，F10 能力探测是动态页面事实） */
	updateCapabilities(runId: string, caps: { auto_save: boolean; auto_submit: boolean }): ManagedRun {
		const run = this.mustRun(runId);
		run.capabilities = caps;
		log.info(`[run ${runId}] capabilities → ${JSON.stringify(caps)}`);
		return run;
	}

	// ---------- 题目 ----------

	registerQuestion(runId: string, q: Omit<ManagedQuestion, 'status' | 'requestedAt' | 'deadline'> & { status?: ManagedQuestion['status'] }): ManagedQuestion {
		const run = this.mustRun(runId);
		const now = Date.now();
		const mq: ManagedQuestion = {
			...q,
			status: q.status ?? 'pending',
			requestedAt: now,
			deadline: now + QUESTION_DEADLINE_MS
		};
		run.questions.set(mq.id, mq);
		log.info(`[run ${runId}] question registered ${mq.id} (${mq.type}, ${mq.title.slice(0, 30)}...)`);
		return mq;
	}

	/** agent 回填（submit_answer / submit_answers） */
	submitAnswer(runId: string, questionId: string, answer: string | string[] | null, encoded: string | null): ManagedQuestion {
		const run = this.mustRun(runId);
		if (isTerminalRun(run.status)) {
			throw new McpToolError(`run 已终态（${run.status}），不能回填答案。`);
		}
		const q = run.questions.get(questionId);
		if (!q) {
			throw new McpToolError(`题目 ${questionId} 不存在于 run ${runId}。`);
		}
		if (q.status !== 'pending') {
			throw new McpToolError(`题目 ${questionId} 已是 ${q.status} 状态，不能重复回填（重复回填返回明确错误）。`);
		}
		q.answer = answer ?? undefined;
		q.encodedAnswer = encoded ?? undefined;
		q.status = encoded === null ? 'skipped' : 'answered';
		log.info(`[run ${runId}] answer submitted ${questionId} (${q.status})`);
		return q;
	}

	/** 页面侧逐题应用结果（question-result 事件） */
	applyQuestionResult(runId: string, questionId: string, status: ManagedQuestion['status'], detail?: string, finish?: boolean): ManagedQuestion | undefined {
		const run = this.runs.get(runId);
		if (!run) return undefined;
		const q = run.questions.get(questionId);
		if (!q) return undefined;
		// 迟到的 applied/applied-failed 可覆盖 sweeper 标记的 timeout（页面是应用事实的来源）
		if (isTerminalQuestion(q.status) && !(q.status === 'timeout' && (status === 'applied' || status === 'applied-failed'))) {
			return q;
		}
		q.status = status;
		q.detail = detail;
		if (finish !== undefined) q.finish = finish;
		else if (status === 'applied') q.finish = true;
		log.info(`[run ${runId}] question-result ${questionId}: ${status}`);
		this.maybeTransitionReady(run);
		return q;
	}

	/** 权威 deadline（题目入队时开始计时）；下行推送给 frame */
	questionDeadline(questionId: string): number | undefined {
		for (const run of this.runs.values()) {
			const q = run.questions.get(questionId);
			if (q) return q.deadline;
		}
		return undefined;
	}

	/** work-completed：整卷作答结束（ready_for_review 的必要条件之一） */
	markWorkCompleted(runId: string, gen: string): boolean {
		const run = this.mustRun(runId);
		if (gen && run.frameGen && gen !== run.frameGen) {
			log.warn(`[run ${runId}] work-completed from stale gen ${gen} (current ${run.frameGen})，忽略`);
			return false;
		}
		run.workCompleted = true;
		this.maybeTransitionReady(run);
		return true;
	}

	private maybeTransitionReady(run: ManagedRun) {
		if (run.status !== 'running') return;
		if (!run.workCompleted) return;
		for (const q of run.questions.values()) {
			if (!isTerminalQuestion(q.status)) return;
		}
		this.transition(run, 'ready_for_review');
	}

	/** deadline 兜底清扫：页面不可达或超时过久时标记 timeout（页面自身竞态是主机制） */
	sweepDeadlines(pageAlive: (pageKey: string) => boolean, evaluateOk: (run: ManagedRun) => Promise<boolean>) {
		const now = Date.now();
		for (const run of this.runs.values()) {
			if (isTerminalRun(run.status)) continue;
			for (const q of run.questions.values()) {
				if (isTerminalQuestion(q.status)) continue;
				const grace = q.status === 'answered' ? 60_000 : 10_000;
				if (now < q.deadline + grace) continue;
				if (!pageAlive(run.pageKey)) {
					this.applyQuestionResult(run.id, q.id, 'timeout', '页面不可达，deadline 兜底超时');
					continue;
				}
				evaluateOk(run)
					.then((alive) => {
						if (!alive) {
							this.applyQuestionResult(run.id, q.id, 'timeout', 'frame 不可达，deadline 兜底超时');
						}
					})
					.catch(() => undefined);
			}
		}
	}

	// ---------- 状态机迁移 ----------

	private transition(run: ManagedRun, status: RunStatus) {
		run.status = status;
		log.info(`[run ${run.id}] status → ${status}`);
	}

	/** submit_paper：执行状态机迁移并等待页面结果（saving/submitting 阻塞点） */
	async submitPaper(runId: string, mode: 'temporary' | 'confirm'): Promise<ManagedRun> {
		const run = this.mustRun(runId);
		if (isTerminalRun(run.status)) {
			throw new McpToolError(`run 已终态（${run.status}）。`);
		}
		if (run.submitUncertain) {
			throw new McpToolError('上次提交结果不确定，禁止盲目重复提交；请先人工核对页面结果后用 abort_run 收尾或重新核验。');
		}
		if (mode === 'temporary' && !run.capabilities.auto_save) {
			throw new McpUnsupportedError('auto_save', '当前页面场景不具备自动暂存能力（v1 作业/随堂练习无独立暂存路径），请人工保存后调用 abort_run(reason:"manual-saved") 结束。');
		}
		if (mode === 'confirm' && !run.capabilities.auto_submit) {
			throw new McpUnsupportedError('auto_submit', '当前页面场景不具备自动提交能力，请人工提交后调用 abort_run(reason:"manual-saved") 结束。');
		}
		if (run.status !== 'ready_for_review' && run.status !== 'saved') {
			throw new McpToolError(`run 状态为 ${run.status}，不能在此状态提交（需要 ready_for_review 或 saved）。`);
		}

		if (mode === 'temporary') {
			this.transition(run, 'saving');
		} else {
			this.transition(run, 'submitting');
		}
		return run;
	}

	/** 页面侧提交结果回执（submit-result 事件 / 超时核验） */
	applySubmitResult(runId: string, mode: 'temporary' | 'confirm', ok: boolean, evidence: string): ManagedRun {
		const run = this.mustRun(runId);
		if (ok) {
			if (mode === 'temporary') {
				this.resetReentryCounter(run);
				if (run.mode === 'course') {
					// 课程模式：暂存成功即预期导航，saved-and-left 终态（ADR-0020 §2）
					this.transition(run, 'saved');
					this.transition(run, 'saved-and-left');
				} else {
					this.transition(run, 'saved'); // 手动模式页面仍占用，可再 confirm
				}
			} else {
				this.resetReentryCounter(run);
				this.transition(run, 'finished');
			}
			if (this.activeRunId === run.id) this.activeRunId = null;
			run.submitUncertain = false;
		} else {
			run.submitUncertain = false;
			run.submitError = evidence;
			// saving 失败退回 ready_for_review（保留重试入口，run 不终态）
			this.transition(run, 'ready_for_review');
		}
		return run;
	}

	/** 提交结果不确定：标记后由调用方 readResult 核验（ADR-0020 §7） */
	markSubmitUncertain(runId: string, reason: string): ManagedRun {
		const run = this.mustRun(runId);
		run.submitUncertain = true;
		run.submitError = reason;
		this.transition(run, 'ready_for_review');
		return run;
	}

	/** abort_run：reason='manual-saved' → released，否则 aborted（终态） */
	abortRun(runId: string, reason?: string): ManagedRun {
		const run = this.mustRun(runId);
		if (isTerminalRun(run.status)) {
			throw new McpToolError(`run 已终态（${run.status}）。`);
		}
		const released = reason === 'manual-saved';
		this.transition(run, released ? 'released' : 'aborted');
		if (this.activeRunId === run.id) this.activeRunId = null;
		// 注意：abort 不重置重进计数——闯关受阻检测依赖"未取得进展的连续进入"累计（ADR-0020 §6）；
		// 仅 saved/finished 等取得进展的终态才重置（见 applySubmitResult 成功路径）
		return run;
	}

	// ---------- frame 生命周期 ----------

	/** frame document 代次变化：绑定该 frame 的未终态 run 视为分离 → aborted */
	handleFrameRebirth(frameUrl: string, newGen: string): ManagedRun | undefined {
		for (const run of this.runs.values()) {
			if (isTerminalRun(run.status)) continue;
			if (run.frameGen && run.frameGen !== newGen && (run.frameUrl === frameUrl || sameFrameUrl(run.frameUrl, frameUrl))) {
				this.transition(run, 'aborted');
				if (this.activeRunId === run.id) this.activeRunId = null;
				log.warn(`[run ${run.id}] aborted: frame 分离（document 代次变化 ${run.frameGen} → ${newGen}）`);
				return run;
			}
		}
		return undefined;
	}

	/** 页面关闭：该页所有未终态 run → aborted */
	handlePageClosed(pageKey: string): ManagedRun[] {
		const aborted: ManagedRun[] = [];
		for (const run of this.runs.values()) {
			if (isTerminalRun(run.status)) continue;
			if (run.pageKey === pageKey) {
				this.transition(run, 'aborted');
				if (this.activeRunId === run.id) this.activeRunId = null;
				aborted.push(run);
			}
		}
		return aborted;
	}

	// ---------- 存储镜像（D16 / ADR-0021 §1） ----------

	setStorageMirror(key: string, value: unknown) {
		this.storageMirror.set(key, value);
	}

	getStorageMirror(): [string, unknown][] {
		return Array.from(this.storageMirror.entries());
	}

	private mustRun(runId: string): ManagedRun {
		const run = this.runs.get(runId);
		if (!run) throw new McpToolError(`run ${runId} 不存在。`);
		return run;
	}
}

/** 宽松 frame URL 相等：忽略查询串（同 frame 重载参数变化不视为分离） */
function sameFrameUrl(a: string, b: string): boolean {
	if (a === b) return true;
	try {
		const ua = new URL(a);
		const ub = new URL(b);
		return ua.origin + ua.pathname === ub.origin + ub.pathname;
	} catch {
		return false;
	}
}

/** 工具层结构化错误 */
export class McpToolError extends Error {}
/** 能力不足的结构化 unsupported 错误（保持 run 状态不变） */
export class McpUnsupportedError extends Error {
	constructor(public capability: 'auto_save' | 'auto_submit', message: string) {
		super(message);
	}
}

/** 页面侧提交结果 */
export interface SubmitPageResult {
	ok: boolean;
	evidence: string;
}
