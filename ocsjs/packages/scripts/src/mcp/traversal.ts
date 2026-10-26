/**
 * 遍历集成与提交适配（F9/F10 页面侧，ADR-0015/0017/0020）：
 * - work-detected 确认制（chapter() 入口上报，server 建 run 回执后才注册题目）；
 * - 出口分类：course-finished / traversal-blocked（附原因）/ page-invalid；
 * - 章节测验提交：waitSubmitCommand 阻塞至 server submit_paper → 执行 noSubmit/btnBlueSubmit
 *   → 以保存/提交请求的响应 JSON 为权威证据确认（$.toast/alert 为辅助信号）→ sendSubmitResult；
 * - readResult 核验探测（提交结果不确定时由 server 主动询问）。
 *
 * 页面保存流（2026-10 实测，doHomeWorkNew 帧）：
 *   noSubmit() → saveWork() → POST /work/addStudentWorkNew?...&tempsave=1（dataType json）
 *   → 响应 {status:true} → $.toast success '保存成功！' → 1s 后 reload；
 *   → 响应 {status:false, msg} → $.toast failure，不 reload；
 *   → ajax complete 回调重置 tempSave=false（重试 noSubmit 不会空转）。
 *   btnBlueSubmit() → validateTimeNew → toadd(...) → confirmSubmitWork() → POST form1
 *   → 响应 {status:true} → workPop 或跳转 data.url。
 */

import { getBridge, MCPBridge, SubmitMode, SubmitCommand } from './bridge';

/** 章节测验提交执行器注册表（由 cx.ts 场景代码注册，保持本模块与平台解耦） */
type ChapterSubmitExecutor = (mode: SubmitMode) => Promise<{ ok: boolean; evidence: string }>;

let chapterSubmitExecutor: ChapterSubmitExecutor | undefined;

export function registerChapterSubmitExecutor(executor: ChapterSubmitExecutor) {
	chapterSubmitExecutor = executor;
}

/**
 * chapter() 入口：work-detected 确认制上报。
 * 返回 null 表示 server 拒绝（互斥/闯关受阻），调用方应停止本次答题并按 reason 处理。
 */
export async function mcpWorkDetected(payload: {
	identity: { courseId?: string; clazzId?: string; chapterId?: string; jobId?: string };
	jobName?: string;
	href?: string;
}): Promise<{ runId: string; sessionId: string | null } | null> {
	const bridge = getBridge();
	if (!bridge) return null;
	const ack = await bridge.notifyWorkDetected(payload as Record<string, unknown>);
	if (!ack.ok || !ack.run_id) {
		console.warn('[mcp-traversal] work-detected 被拒绝：', ack.reason);
		return null;
	}
	return { runId: ack.run_id, sessionId: ack.session_id ?? null };
}

/** chapter() 提交等待：阻塞至 server submit_paper / abort（取消） */
export async function mcpWaitSubmitCommand(): Promise<SubmitCommand | { cancelled: true }> {
	const bridge = getBridge();
	if (!bridge) return { cancelled: true };
	return bridge.waitSubmitCommand();
}

export function mcpSendSubmitResult(
	command: SubmitCommand,
	ok: boolean,
	evidence: string,
	uncertain = false
): Promise<unknown> {
	return getBridge()?.sendSubmitResult(command, ok, evidence, uncertain) ?? Promise.resolve(undefined);
}

// ---------- 提交证据捕获 ----------

interface SaveCapture {
	/** jQuery ajax 完成事件：{url, status, body} */
	ajax: Array<{ url: string; status: number; body: string }>;
	/** $.toast / alert 消息：{type, content} */
	notices: Array<{ type: string; content: string }>;
	restore: () => void;
}

/**
 * 安装页面侧证据捕获：包装 $.ajax（权威——页面成功分支由响应 JSON 的 data.status 决定）、
 * $.toast 与 alert（辅助）。页面用 jQuery（mooc2/js/poptoast.js + $.ajax，对象参数形式）。
 */
function installSaveCapture(frameWindow: Window): SaveCapture | undefined {
	const win = frameWindow as unknown as {
		$:
			| undefined
			| (((...args: unknown[]) => unknown) & { ajax?: (...args: unknown[]) => unknown; toast?: (o: unknown) => void });
		alert?: (...args: unknown[]) => void;
	};
	const jq = win.$;
	if (typeof jq !== 'function' || typeof jq.ajax !== 'function') return undefined;
	const originalDocument = frameWindow.document;
	const capture: SaveCapture = { ajax: [], notices: [], restore: () => undefined };
	const originalAjax = jq.ajax;
	const originalToast = jq.toast;
	const originalAlert = win.alert;

	const wrappedAjax = function (this: unknown, ...args: unknown[]) {
		const opts = args[0] as { url?: string; success?: (...values: unknown[]) => void } | undefined;
		if (!opts || typeof opts !== 'object') return originalAjax.apply(this, args);
		const url = String(opts.url ?? '');
		const originalSuccess = opts.success;
		return originalAjax.call(
			this,
			{
				...opts,
				success: function (this: unknown, ...values: unknown[]) {
					const data = values[0];
					// 必须在平台原回调（可能立即导航）之前保存本次捕获器的证据。
					capture.ajax.push({ url, status: 200, body: typeof data === 'string' ? data : JSON.stringify(data ?? {}) });
					return originalSuccess?.apply(this, values);
				}
			},
			...args.slice(1)
		);
	};
	const wrappedToast = (o: unknown) => {
		const t = (o ?? {}) as { type?: string; content?: unknown };
		capture.notices.push({ type: String(t.type ?? ''), content: String(t.content ?? '') });
		originalToast?.call(jq, o);
	};
	const wrappedAlert = (...args: unknown[]) => {
		capture.notices.push({ type: 'alert', content: args.map(String).join(' ') });
		originalAlert?.apply(frameWindow, args);
	};
	capture.restore = () => {
		// jQuery 是原文档对象，不能再次经导航后的 WindowProxy 读取 win.$。
		const restore = (name: string, action: () => void) => {
			try {
				action();
			} catch (error) {
				reportSubmitError(`清理 ${name}`, error);
			}
		};
		restore('ajax', () => {
			if (jq.ajax === wrappedAjax) jq.ajax = originalAjax;
		});
		restore('toast', () => {
			if (jq.toast === wrappedToast) jq.toast = originalToast;
		});
		restore('alert', () => {
			if (frameWindow.document === originalDocument && win.alert === wrappedAlert) win.alert = originalAlert;
		});
	};
	try {
		jq.ajax = wrappedAjax;
		jq.toast = wrappedToast;
		win.alert = wrappedAlert;
	} catch (error) {
		capture.restore();
		throw error;
	}
	return capture;
}

/** 原异常 stack 同步到 server，诊断本身不能阻断回执。 */
export function reportSubmitError(stage: string, error: unknown) {
	try {
		const detail = (error as { stack?: string } | null)?.stack ?? String(error);
		const pending = getBridge()?.notify('log', { level: 'error', message: `[submit] ${stage}: ${detail}` });
		pending?.catch(() => undefined);
	} catch {
		/* 页面桥也可能正在卸载 */
	}
}

/** 从捕获的 ajax 响应中判定保存/提交结果（权威证据：页面成功分支由响应 JSON data.status 决定）。
 *  /work/validate（提交前置校验，data.status==1 表示可提交）不属于结果信号，必须排除。 */
function judgeFromAjax(capture: SaveCapture, mode: SubmitMode): { ok: boolean; evidence: string } | undefined {
	for (const rec of capture.ajax) {
		if (/\/work\/validate/i.test(rec.url)) continue;
		// 暂存与提交均落在 /work/addStudentWorkNew（tempsave=1 区分），确认端点族
		if (!/addStudentWorkNew/i.test(rec.url)) continue;
		let parsed: { status?: unknown; msg?: unknown } | undefined;
		try {
			parsed = JSON.parse(rec.body);
		} catch {
			// body 非 JSON（jQuery dataType json 下 success 已解析，此处防御）
		}
		const okFlag = parsed?.status;
		if (typeof okFlag === 'boolean' || typeof okFlag === 'number') {
			const ok = okFlag === true || okFlag === 1;
			return {
				ok,
				evidence: `${mode === 'temporary' ? '暂存' : '提交'}请求响应 status=${String(okFlag)}${
					parsed?.msg ? ' msg=' + String(parsed.msg) : ''
				}（HTTP ${rec.status}）`
			};
		}
	}
	return undefined;
}

/** 从 toast/alert 判定（辅助证据；'保存成功！'/'提交成功' 等） */
function judgeFromNotices(capture: SaveCapture): { ok: boolean; evidence: string } | undefined {
	for (const n of capture.notices) {
		if (/保存成功|提交成功/.test(n.content)) return { ok: true, evidence: `页面提示成功：${n.type} ${n.content}` };
		if (n.type === 'failure' || /失败/.test(n.content))
			return { ok: false, evidence: `页面提示失败：${n.type} ${n.content}` };
	}
	return undefined;
}

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 执行章节测验提交（noSubmit / btnBlueSubmit + submitCheckTimes）。
 * 成功以响应为准：捕获保存/提交请求的响应 JSON（页面成功分支的权威信号），
 * toast/alert 为辅助；超时无任何证据时保守判定失败（保留重试入口）。
 */
export async function executeChapterSubmit(
	frameWindow: Window & { noSubmit?: () => void; btnBlueSubmit?: () => void; submitCheckTimes?: () => void },
	mode: SubmitMode
): Promise<{ ok: boolean; evidence: string }> {
	if (chapterSubmitExecutor) {
		return chapterSubmitExecutor(mode);
	}

	const capture = installSaveCapture(frameWindow);
	if (!capture) {
		return { ok: false, evidence: '页面缺少 jQuery/$.ajax，无法触发并确认保存' };
	}

	try {
		if (mode === 'temporary') {
			if (typeof frameWindow.noSubmit !== 'function') {
				return { ok: false, evidence: '页面缺少 noSubmit 函数（页面结构可能已变化）' };
			}
			frameWindow.noSubmit();
		} else {
			if (typeof frameWindow.btnBlueSubmit !== 'function') {
				return { ok: false, evidence: '页面缺少 btnBlueSubmit 函数（页面结构可能已变化）' };
			}
			frameWindow.btnBlueSubmit();
			const confirmationAt = Date.now() + 3000;
			while (Date.now() < confirmationAt) {
				const judged = judgeFromAjax(capture, mode) ?? judgeFromNotices(capture);
				if (judged) return judged;
				await sleep(100);
			}
			const judged = judgeFromAjax(capture, mode) ?? judgeFromNotices(capture);
			if (judged) return judged;
			if (typeof frameWindow.submitCheckTimes === 'function') {
				frameWindow.submitCheckTimes();
			}
			// 2024/4 更新后需手动关闭确定弹窗
			try {
				const topWin = getOperationWindow() as unknown as { $?: (sel: string) => { hide: () => void } };
				if (typeof topWin.$ === 'function') {
					topWin.$('#workpop')?.hide();
				}
			} catch {
				// 无 jQuery 时忽略
			}
		}

		// 轮询等待证据：ajax 响应（权威）→ toast/alert（辅助）。成功后页面 1s 内 reload，需尽快回执。
		const deadline = Date.now() + 15_000;
		while (Date.now() < deadline) {
			await sleep(300);
			const judged = judgeFromAjax(capture, mode) ?? judgeFromNotices(capture);
			if (judged) {
				return judged;
			}
		}
		const raw = JSON.stringify({ ajax: capture.ajax, notices: capture.notices }).slice(0, 400);
		return { ok: false, evidence: `15s 内未捕获保存/提交响应或页面提示（捕获：${raw}），保守判定失败` };
	} catch (error) {
		const judged = judgeFromAjax(capture, mode) ?? judgeFromNotices(capture);
		reportSubmitError('执行', error);
		if (judged) return judged;
		throw error;
	} finally {
		capture.restore();
	}
}

/** 同一个测验在 API、作答页和结果页的参数名大小写不同。 */
function taskIdentity(win: Window): Record<string, string> {
	const values: Record<string, string> = {};
	const aliases: Record<string, string> = {
		courseid: 'courseId',
		clazzid: 'clazzId',
		classid: 'clazzId',
		knowledgeid: 'chapterId',
		chapterid: 'chapterId',
		jobid: 'jobId',
		workid: 'workId',
		workanswerid: 'workAnswerId'
	};
	new URL(win.location.href).searchParams.forEach((value, key) => {
		if (aliases[key.toLowerCase()] && value) values[aliases[key.toLowerCase()]] = value;
	});
	win.document.querySelectorAll<HTMLInputElement>('input[type="hidden"]').forEach((input) => {
		const key = aliases[(input.name || input.id).toLowerCase()];
		if (key && input.value && !values[key]) values[key] = input.value;
	});
	return values;
}

/** 在真实章节入口注册；闭包绑定本 run 的子 frame 与任务身份。 */
export function registerChapterResultProbe(frame: HTMLIFrameElement, identity: Record<string, string | undefined>) {
	const initialWindow = frame.contentWindow;
	if (!initialWindow) return;
	const expected = { ...identity, ...taskIdentity(initialWindow) };
	getBridge()?.registerResultProbe(() => {
		// iframe 元素可能被替换；逐个核对任务身份，不能探测下一章或任意结果页。
		const frames = frame.isConnected ? [frame] : Array.from(document.querySelectorAll<HTMLIFrameElement>('iframe'));
		for (const candidate of frames) {
			try {
				const win = candidate.contentWindow;
				if (!win) continue;
				const actual = taskIdentity(win);
				const anchor = ['jobId', 'workAnswerId', 'workId'].some(
					(key) => expected[key] && actual[key] === expected[key]
				);
				if (
					!anchor ||
					['courseId', 'clazzId'].some((key) => expected[key] && actual[key] !== expected[key]) ||
					Object.keys(expected).some((key) => expected[key] && actual[key] && actual[key] !== expected[key])
				)
					continue;
				return probeChapterResult(win);
			} catch {
				/* 跨域/导航中的候选不能作为成功证据 */
			}
		}
		return { saved: false, submitted: false, evidence: '未找到身份匹配的测验子 frame' };
	});
}

/** 只能在身份核对后的测验子 frame 中探测。表单有答案不能证明已暂存。 */
export function probeChapterResult(win: Window): Record<string, unknown> {
	try {
		const doc = win.document;
		const href = win.location.href;
		const hasTiMu = doc.querySelectorAll('.TiMu').length > 0;
		const chapterComplete =
			doc.querySelector('.testTit_status')?.classList.contains('testTit_status_complete') ?? false;
		const submitted = chapterComplete || /\/work\/(?:selectWorkQuestionYiPiYue|view)(?:[/?#]|$)/i.test(href);
		return { hasTiMu, chapterComplete, saved: false, submitted, href, evidence: href };
	} catch (error) {
		return { error: String(error), saved: false, submitted: false };
	}
}

/** cx env 脚本的"真 top"窗口（章节测验所在层级，能访问 $ / PCount 等页面全局） */
function getOperationWindow(): Window {
	try {
		let w: Window = window;
		let count = 5;
		while (w.parent && w.parent !== w && count-- > 0) {
			if (w.location.href.includes('/mycourse/studentstudy')) return w;
			w = w.parent as Window;
		}
		return w;
	} catch {
		return window;
	}
}

// ---------- 遍历出口事件（F9） ----------

export function mcpNotifyCourseFinished(reason: string) {
	getBridge()?.notify('course-finished', { reason });
}

// ---------- 手动作业页提交适配（F10 扩展，ADR-0018 P3 能力探测扩展） ----------

/**
 * 注册页面侧保存/提交能力（作业页在脚本加载时探测：saveWork 存在 → auto_save）。
 * server 经 bridge.getCapabilities() 查询后写入 run.capabilities。
 */
export function mcpRegisterSubmitCapabilities(provider: () => { auto_save: boolean; auto_submit: boolean }) {
	getBridge()?.setManualCapabilities(provider);
}

/**
 * 作业页（/mooc2/work/dowork）提交执行：
 * - temporary：调用页面 saveWork()（「暂时保存」按钮同路径，pyFlag=1 暂存标志，
 *   响应 JSON data.status 为权威证据，成功 toast『保存成功！完成后请及时提交作业！』）；
 * - confirm：作业页 v1 不具备自动提交能力（auto_submit=false，server 侧已拦截），不应到达此处。
 */
export async function executeWorkSubmit(
	frameWindow: Window & { saveWork?: (options?: unknown) => void },
	mode: SubmitMode
): Promise<{ ok: boolean; evidence: string }> {
	if (mode !== 'temporary') {
		return { ok: false, evidence: '作业场景不具备自动提交能力（auto_submit=false），请人工提交' };
	}
	if (typeof frameWindow.saveWork !== 'function') {
		return { ok: false, evidence: '页面缺少 saveWork 函数（页面结构可能已变化）' };
	}
	const capture = installSaveCapture(frameWindow);
	if (!capture) {
		return { ok: false, evidence: '页面缺少 jQuery/$.ajax，无法触发并确认保存' };
	}
	try {
		frameWindow.saveWork();
		// 轮询等待证据（saveWork 内部 saveLock 防重入，complete 回调解锁，可安全重试）
		const deadline = Date.now() + 15_000;
		while (Date.now() < deadline) {
			await sleep(300);
			const judged = judgeFromAjax(capture, mode) ?? judgeFromNotices(capture);
			if (judged) {
				return judged;
			}
		}
		const raw = JSON.stringify({ ajax: capture.ajax, notices: capture.notices }).slice(0, 400);
		return { ok: false, evidence: `15s 内未捕获保存响应或页面提示（捕获：${raw}），保守判定失败` };
	} catch (error) {
		const judged = judgeFromAjax(capture, mode) ?? judgeFromNotices(capture);
		reportSubmitError('执行', error);
		if (judged) return judged;
		throw error;
	} finally {
		capture.restore();
	}
}

export function mcpNotifyTraversalBlocked(reason: string) {
	getBridge()?.notify('traversal-blocked', { reason });
}

export function mcpNotifyPageInvalid(reason: string) {
	getBridge()?.notify('page-invalid', { reason });
}

export function mcpNotifyLog(message: string, level = 'info') {
	getBridge()?.notify('log', { message, level });
}

/** 媒体任务点跳过日志（F5 守卫路径统一走这里，server 可见） */
export function mcpLogMediaSkipped(jobName: string, entry: string) {
	mcpNotifyLog(`媒体任务点已硬禁用（${entry}）：${jobName} 跳过`, 'media-skip');
}

export function getMCPBridge(): MCPBridge | undefined {
	return getBridge();
}
