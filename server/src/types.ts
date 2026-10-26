/**
 * 共享类型：run 状态机 / 事件信封 / 页面事件（ADR-0017/0020/0021，开发文档 §3.1/§3.2）
 */

/** run 状态机（D13/D19） */
export type RunStatus =
	| 'running'
	| 'ready_for_review'
	| 'saving'
	| 'saved'
	| 'saved-and-left'
	| 'submitting'
	| 'finished'
	| 'released'
	| 'aborted';

/** 终态：释放单 run 互斥 */
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
	'finished',
	'saved-and-left',
	'released',
	'aborted'
] as const;

export function isTerminalRun(status: RunStatus): boolean {
	return TERMINAL_RUN_STATUSES.includes(status);
}

/** 逐题状态（§4 get_status） */
export type QuestionStatus =
	| 'pending'
	| 'answered'
	| 'applied'
	| 'applied-failed'
	| 'timeout'
	| 'skipped'
	| 'unsupported';

/** 题目终态：ready_for_review 要求全部题目到达终态 */
export const TERMINAL_QUESTION_STATUSES: readonly QuestionStatus[] = [
	'applied',
	'applied-failed',
	'timeout',
	'skipped',
	'unsupported'
] as const;

export function isTerminalQuestion(status: QuestionStatus): boolean {
	return TERMINAL_QUESTION_STATUSES.includes(status);
}

/** cx 题目类型（cx.ts getQuestionType） */
export type QuestionType = 'single' | 'multiple' | 'judgement' | 'completion' | 'line' | 'fill' | 'reader';

/** v1 支持回填的题型（D15；连线/完形/阅读 unsupported 跳过） */
export const SUPPORTED_QUESTION_TYPES: readonly QuestionType[] = ['single', 'multiple', 'judgement', 'completion'];

/** 页面上行事件类型（frame → server，经 exposeBinding('__mcpEvent')） */
export type PageEventType =
	| 'hello' // frame bootstrap 公告（携带 document 代次与 origin，用于存储快照下发与代次追踪）
	| 'storage' // GM 存储变更（跨源中继请求）
	| 'log'
	| 'work-detected' // 确认制：server 建 run 后经 binding 返回值回执
	| 'question'
	| 'question-result'
	| 'work-completed'
	| 'submit-result'
	| 'read-result'
	| 'course-finished'
	| 'traversal-blocked'
	| 'page-invalid';

/** 事件信封：遍历级（session_id + 单调 event_id，可无 run_id）与 run 级（+run_id）（ADR-0020 §4） */
export interface Envelope {
	eventId: number;
	sessionId: string | null;
	runId: string | null;
	type: PageEventType;
	payload: Record<string, unknown>;
	/** 事件来源 frame：URL 与 document 代次 */
	frame: { url: string; gen: string };
	ts: number;
}

/** wait_next_work 可投递的事件类型（其余事件仅入历史，供诊断） */
export const DELIVERABLE_EVENT_TYPES: readonly PageEventType[] = [
	'work-detected',
	'course-finished',
	'traversal-blocked',
	'page-invalid'
] as const;

/** 重进计数身份（F9，ADR-0020 §6）：course/clazz/chapter/job（jobid） */
export interface RunIdentity {
	courseId?: string;
	clazzId?: string;
	chapterId?: string;
	jobId?: string;
}

export function identityKey(identity: RunIdentity | null | undefined): string {
	if (!identity) return '';
	return [identity.courseId, identity.clazzId, identity.chapterId, identity.jobId].map((v) => v ?? '-').join('|');
}

/** 单题 300s 计时（ADR-0007/0019：从题目入队起计时） */
export const QUESTION_DEADLINE_MS = 300_000;

/** 题目（server 视角） */
export interface ManagedQuestion {
	id: string;
	type: QuestionType;
	title: string;
	options?: string[];
	/** 图片 URL 数组（server 经 context.request 下载后转 image content block） */
	images?: string[];
	blankCount?: number;
	status: QuestionStatus;
	/** agent 提交的原始答案（编码前） */
	answer?: string | string[];
	/** 编码后写入 SearchInformation.answer 的字符串 */
	encodedAnswer?: string;
	/** 应用结果是否 finish（applied 时为 true） */
	finish?: boolean;
	/** 失败/超时详情 */
	detail?: string;
	requestedAt: number;
	deadline: number;
}

/** run（server 权威状态） */
export interface ManagedRun {
	id: string;
	/** 课程遍历 run 绑定 session；手动 run 为 null */
	sessionId: string | null;
	mode: 'course' | 'manual';
	pageKey: string;
	/** run 所在 frame 的 URL（下行 evaluate 目标） */
	frameUrl: string;
	/** document 代次：代次变化视为 frame 分离 */
	frameGen: string;
	identity: RunIdentity | null;
	jobName?: string;
	status: RunStatus;
	questions: Map<string, ManagedQuestion>;
	capabilities: { auto_save: boolean; auto_submit: boolean };
	workCompleted: boolean;
	createdAt: number;
	/** 提交结果不确定标记（ADR-0020 §7：先 readResult 核验，禁止盲目重复提交） */
	submitUncertain?: boolean;
	submitError?: string;
}
