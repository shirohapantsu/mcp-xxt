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

import { getBridge, MCPBridge, SubmitMode } from './bridge';

/** 章节测验提交执行器注册表（由 cx.ts 场景代码注册，保持本模块与平台解耦） */
type ChapterSubmitExecutor = (mode: SubmitMode) => Promise<{ ok: boolean; evidence: string }>;

let chapterSubmitExecutor: ChapterSubmitExecutor | undefined;

export function registerChapterSubmitExecutor(executor: ChapterSubmitExecutor) {
	chapterSubmitExecutor = executor;
	const bridge = getBridge();
	if (bridge) {
		bridge.registerResultProbe(() => probeChapterResult());
	}
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
export async function mcpWaitSubmitCommand(): Promise<{ mode: SubmitMode } | { cancelled: true }> {
	const bridge = getBridge();
	if (!bridge) return { cancelled: true };
	return bridge.waitSubmitCommand();
}

export function mcpSendSubmitResult(mode: SubmitMode, ok: boolean, evidence: string): Promise<unknown> {
	return getBridge()?.sendSubmitResult(mode, ok, evidence) ?? Promise.resolve(undefined);
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
		$: undefined | ((...args: unknown[]) => unknown) & { ajax?: (...args: unknown[]) => unknown; toast?: (o: unknown) => void };
		alert?: (...args: unknown[]) => void;
	};
	if (typeof win.$ !== 'function' || typeof win.$.ajax !== 'function') {
		return undefined;
	}
	const capture: SaveCapture = { ajax: [], notices: [], restore: () => undefined };
	const originalAjax = win.$.ajax.bind(win.$);
	const originalToast = win.$.toast;
	const originalAlert = win.alert;

	win.$.ajax = (...args: unknown[]) => {
		const opts = args[0] as { url?: string; success?: (data: unknown) => void } | undefined;
		if (!opts || typeof opts !== 'object') {
			// 字符串 URL 形式原样透传（页面保存流为对象形式）
			return originalAjax(...args);
		}
		const url = String(opts.url ?? '');
		const originalSuccess = opts.success;
		const wrapped = {
			...opts,
			success: (data: unknown) => {
				capture.ajax.push({
					url,
					status: 200,
					body: typeof data === 'string' ? data : JSON.stringify(data ?? {}).slice(0, 500)
				});
				originalSuccess?.(data);
			}
		};
		return originalAjax(wrapped);
	};

	const jq = win.$;
	win.$.toast = (o: unknown) => {
		const t = (o ?? {}) as { type?: string; content?: unknown };
		capture.notices.push({ type: String(t.type ?? ''), content: String(t.content ?? '') });
		originalToast?.call(jq, o);
	};
	win.alert = (...args: unknown[]) => {
		capture.notices.push({ type: 'alert', content: args.map(String).join(' ') });
		originalAlert?.apply(frameWindow, args);
	};

	capture.restore = () => {
		if (win.$) {
			win.$.ajax = originalAjax as typeof win.$.ajax;
			win.$.toast = originalToast;
		}
		win.alert = originalAlert;
	};
	return capture;
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
				evidence: `${mode === 'temporary' ? '暂存' : '提交'}请求响应 status=${String(okFlag)}${parsed?.msg ? ' msg=' + String(parsed.msg) : ''}（HTTP ${rec.status}）`
			};
		}
	}
	return undefined;
}

/** 从 toast/alert 判定（辅助证据；'保存成功！'/'提交成功' 等） */
function judgeFromNotices(capture: SaveCapture): { ok: boolean; evidence: string } | undefined {
	for (const n of capture.notices) {
		if (/保存成功|提交成功/.test(n.content)) return { ok: true, evidence: `页面提示成功：${n.type} ${n.content}` };
		if (n.type === 'failure' || /失败/.test(n.content)) return { ok: false, evidence: `页面提示失败：${n.type} ${n.content}` };
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
			await sleep(3000);
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
	} finally {
		capture.restore();
	}
}

/** 页面状态探测（readResult 核验）：必须返回 saved / submitted 属性（server 核验契约） */
export function probeChapterResult(): Record<string, unknown> {
	try {
		// 本帧即章节测验帧（doHomeWorkNew）：.TiMu 与表单答案在本地文档
		const hasTiMu = document.querySelectorAll('.TiMu').length > 0;
		// 表单已有答案（暂存成功 reload 后会把已保存答案回填进表单）；
		// 注意排除 answertype*（题型隐藏 input，恒有值）
		let answeredInputs = 0;
		document.querySelectorAll<HTMLInputElement>('input[id^="answer"]').forEach((el) => {
			if (/^answer\d+$/.test(el.id) && el.value && el.value.trim().length > 0) answeredInputs++;
		});
		const selectedOptions = document.querySelectorAll('.check_answer').length;
		// 顶层弹窗与测验状态元素在外层（studentstudy / knowledge cards）
		let workpopVisible = false;
		try {
			const jq = (getOperationWindow() as unknown as { $?: (sel: string) => { is?: (sel: string) => boolean } }).$;
			if (typeof jq === 'function') {
				workpopVisible = !!jq('#workpop')?.is?.(':visible');
			}
		} catch {
			// 忽略
		}
		const statusEl = document.querySelector<HTMLElement>('.testTit_status');
		const chapterComplete = statusEl?.classList.contains('testTit_status_complete') ?? false;
		const saved = hasTiMu && (answeredInputs > 0 || selectedOptions > 0);
		const submitted =
			chapterComplete ||
			/work\/view|submit=true/i.test(location.href);
		return { hasTiMu, answeredInputs, selectedOptions, workpopVisible, chapterComplete, saved, submitted, href: location.href };
	} catch (e) {
		return { error: String(e), saved: false, submitted: false };
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
