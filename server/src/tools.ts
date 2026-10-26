/**
 * MCP 工具层：11 个工具（开发文档 §4），全部带 zod inputSchema。
 */

import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { BrowserHost, COURSE_STUDY_URL_PATTERN, WORK_PAGE_PATTERNS } from './browser.js';
import { EventRouter } from './inject.js';
import { Adapters } from './adapters.js';
import { McpToolError, McpUnsupportedError, RunManager, WaitNextWorkResponse } from './run-manager.js';
import { checkLoginStatus, loadAccountConfig, openLogin } from './login.js';
import { encodeAnswer, validateCompletionString } from './answer-encoding.js';
import { isTerminalQuestion, ManagedQuestion, ManagedRun } from './types.js';
import { log } from './log.js';

/** MCP image content block 的大小上限（base64 前字节数） */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

type ToolContent = CallToolResult['content'];
type ToolResult = {
	content: ToolContent;
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
};

export interface ToolDeps {
	browser: BrowserHost;
	rm: RunManager;
	router: EventRouter;
	adapters: Adapters;
	/** 当前操作页（open_page 维护） */
	currentPage: () => import('playwright').Page | undefined;
	setCurrentPage: (page: import('playwright').Page | undefined) => void;
}

export function text(t: string): ToolContent[number] {
	return { type: 'text', text: t } as ToolContent[number];
}

export function imageBlock(data: string, mimeType: string): ToolContent[number] {
	return { type: 'image', data, mimeType } as ToolContent[number];
}

export function toolError(message: string, structured?: Record<string, unknown>): ToolResult {
	return {
		isError: true,
		content: [text(message)],
		...(structured ? { structuredContent: structured } : {})
	};
}

function questionSummary(q: ManagedQuestion): Record<string, unknown> {
	const out: Record<string, unknown> = {
		id: q.id,
		type: q.type,
		title: q.title,
		status: q.status,
		resolved: ['applied', 'applied-failed', 'timeout', 'skipped', 'unsupported'].includes(q.status),
		requestedAt: q.requestedAt,
		deadline: q.deadline
	};
	if (q.options) out.options = q.options;
	if (q.images?.length) out.images = q.images;
	if (q.answer !== undefined) out.answer = q.answer;
	if (q.finish !== undefined) out.finish = q.finish;
	if (q.detail) out.detail = q.detail;
	if (q.status === 'unsupported') out.note = '未作答（题型不支持，v1 连线/完形/阅读跳过）';
	return out;
}

function runStatusPayload(run: ManagedRun): Record<string, unknown> {
	return {
		run_id: run.id,
		mode: run.mode,
		status: run.status,
		session_id: run.sessionId ?? undefined,
		job_name: run.jobName,
		identity: run.identity ?? undefined,
		capabilities: run.capabilities,
		work_completed: run.workCompleted,
		question_count: run.questions.size,
		questions: Array.from(run.questions.values()).map(questionSummary),
		submit_uncertain: run.submitUncertain ?? false,
		submit_error: run.submitError,
		created_at: run.createdAt
	};
}

/** 答案输入（D15/D19/D20）：文本/字母/选项文本数组/JSON 数组/null=跳过 */
const answerSchema = z
	.union([z.string(), z.array(z.string()), z.null()])
	.describe(
		'答案：选项文本或字母（"A"、"ABD"）；填空题传 string[]（每空一项，JSON 编码无损还原）；纯 string 按分隔符语义表达多个答案；null 表示跳过该题'
	);

export function registerTools(server: import('@modelcontextprotocol/sdk/server/mcp.js').McpServer, deps: ToolDeps) {
	const { browser, rm, router, adapters } = deps;

	// ---------- open_login ----------
	server.registerTool(
		'open_login',
		{
			title: '打开登录页',
			description:
				'打开超星学习通登录页并自动尝试配置的账号密码登录；验证码/风控转人工（返回截图），登录态由持久 profile 保留。'
		},
		async (): Promise<ToolResult> => {
			const account = loadAccountConfig();
			const result = await openLogin(browser, account);
			const content: ToolContent = [text(result.detail)];
			if (result.screenshotBase64) {
				content.push(imageBlock(result.screenshotBase64, 'image/png'));
			}
			return { content, structuredContent: { status: result.status, detail: result.detail } };
		}
	);

	// ---------- get_login_status ----------
	server.registerTool(
		'get_login_status',
		{
			title: '查询登录态',
			description: '检测超星学习通登录态（基于持久 profile cookie）。'
		},
		async (): Promise<ToolResult> => {
			const status = await checkLoginStatus(browser);
			return { content: [text(status.detail)], structuredContent: { loggedIn: status.loggedIn, detail: status.detail } };
		}
	);

	// ---------- open_page ----------
	server.registerTool(
		'open_page',
		{
			title: '打开页面',
			description:
				'通用页面导航。命中课程学习页（mycourse/studentstudy）时创建新遍历 session 并返回 session_id（旧 session 的 waiter 终止、迟到事件忽略）。',
			inputSchema: { url: z.string().describe('要打开的页面 URL') }
		},
		async ({ url }: { url: string }): Promise<ToolResult> => {
			let page = deps.currentPage();
			const looksLikeCourse = COURSE_STUDY_URL_PATTERN.test(url);
			// 预创建 session：导航期间（含重定向）产生的 frame 事件不丢失
			if (looksLikeCourse) {
				rm.createSession(page ? browser.getPageKey(page) : 'pending-page');
			}
			if (!page) {
				const created = await browser.newPage(url);
				page = created.page;
				deps.setCurrentPage(page);
			} else {
				await browser.navigate(page, url);
			}
			const pageKey = browser.getPageKey(page);
			const session = rm.getCurrentSession();
			const finalUrl = page.url();
			if (session && session.pageKey === 'pending-page' && looksLikeCourse && COURSE_STUDY_URL_PATTERN.test(finalUrl)) {
				rm.rebindSessionPage(session.id, pageKey);
			}
			if (looksLikeCourse && !COURSE_STUDY_URL_PATTERN.test(finalUrl)) {
				rm.terminateSession(session?.id ?? '', 'page-invalid', `导航后未落在课程学习页：${finalUrl}`);
			}
			const title = await page.title().catch(() => '');
			const hitCourse = COURSE_STUDY_URL_PATTERN.test(finalUrl);
			const currentSession = rm.getCurrentSession();
			return {
				content: [text(`已打开：${finalUrl}`)],
				structuredContent: {
					url: finalUrl,
					title,
					...(hitCourse && currentSession ? { session_id: currentSession.id } : {})
				}
			};
		}
	);

	// ---------- start_work ----------
	server.registerTool(
		'start_work',
		{
			title: '启动答题（手动入口）',
			description:
				'在当前作业/随堂练习页面显式启动答题流程，返回 run_id。已有活跃 run 报错；页面不匹配报错。课程遍历模式不要调用（work-detected 自动建 run）。'
		},
		async (): Promise<ToolResult> => {
			const page = deps.currentPage();
			if (!page) return toolError('当前没有已打开的页面，请先 open_page 作业页。');
			const url = page.url();
			if (!WORK_PAGE_PATTERNS.some((p) => p.test(url))) {
				return toolError(`当前页面不是作业/考试/随堂练习页（${url}）。`);
			}
			const mainFrame = page.mainFrame();
			// F10 能力探测：等页面脚本注册保存能力（最多 6s），探测不到按无能力诚实上报
			let caps: { auto_save: boolean; auto_submit: boolean; gen: string } | null = null;
			for (let i = 0; i < 30 && !caps; i++) {
				caps = await router.queryFrameCapabilities(page);
				if (!caps) await new Promise((r) => setTimeout(r, 500));
			}
			// frameGen 必须是页面桥的真实代次（work-completed 事件带 gen 做校验）
			let run: ManagedRun;
			try {
				run = rm.createManualRun({
					pageKey: browser.getPageKey(page),
					frameUrl: mainFrame.url(),
					frameGen: caps?.gen || 'manual:' + Date.now(),
					href: url,
					capabilities: caps ? { auto_save: caps.auto_save, auto_submit: caps.auto_submit } : undefined
				});
			} catch (err) {
				return toolError(err instanceof Error ? err.message : String(err));
			}
			try {
				await router.pushBindRun(run.id, null, mainFrame);
				await router.pushStartManual(run.id);
			} catch (err) {
				rm.abortRun(run.id, 'start_work 下行失败');
				return toolError(`页面侧启动失败（bundle 桥不可达）：${String(err)}`);
			}
			return { content: [text(`run 已创建并下发启动指令：${run.id}`)], structuredContent: { run_id: run.id } };
		}
	);

	// ---------- wait_next_work ----------
	server.registerTool(
		'wait_next_work',
		{
			title: '等待下一个测验',
			description:
				'课程遍历模式下挂起等待下一个测验 run 就绪（work-ready）；超时返回 still-waiting（幂等重调）；课程结束/受阻返回终止事件。按 per-session 游标续读，每事件至多投递一次；重试携带同一 request_id 返回缓存响应。',
			inputSchema: {
				timeout_s: z.number().optional().describe('等待超时秒数，默认 60'),
				request_id: z.string().optional().describe('可选请求 id：客户端超时/取消后重试携带同一 id 返回缓存响应')
			}
		},
		async ({ timeout_s, request_id }: { timeout_s?: number; request_id?: string }): Promise<ToolResult> => {
			const resp: WaitNextWorkResponse = await rm.waitNextWork((timeout_s ?? 60) * 1000, request_id);
			return {
				content: [text(JSON.stringify(resp))],
				structuredContent: resp as unknown as Record<string, unknown>
			};
		}
	);

	// ---------- get_status ----------
	server.registerTool(
		'get_status',
		{
			title: '查询 run 状态',
			description:
				'查询 run 状态与逐题作答结果（审核单数据源）。run_id 缺省返回当前活跃 run——事件丢失时经此重新发现未终态 run。',
			inputSchema: { run_id: z.string().optional().describe('run id；缺省为当前活跃 run') }
		},
		async ({ run_id }: { run_id?: string }): Promise<ToolResult> => {
			const run = rm.getRun(run_id);
			if (!run) {
				return toolError(run_id ? `run ${run_id} 不存在。` : '当前没有活跃 run。', { status: 'no-run' });
			}
			const payload = runStatusPayload(run);
			return { content: [text(JSON.stringify(payload))], structuredContent: payload };
		}
	);

	// ---------- get_pending_questions ----------
	server.registerTool(
		'get_pending_questions',
		{
			title: '获取待答题目',
			description:
				'获取待答题目列表；题目图片放在工具结果顶层 content 数组（image block），元数据在 structuredContent.questions。注意：空 pending ≠ 完成（以 get_status 的 ready_for_review 为准）。',
			inputSchema: { run_id: z.string().describe('run id') }
		},
		async ({ run_id }: { run_id: string }): Promise<ToolResult> => {
			const run = rm.getRun(run_id);
			if (!run) return toolError(`run ${run_id} 不存在。`);
			const pending = Array.from(run.questions.values()).filter((q) => q.status === 'pending');

			const content: ToolContent = [];
			const structuredQuestions: Array<Record<string, unknown>> = [];
			for (const q of pending) {
				structuredQuestions.push({
					id: q.id,
					type: q.type,
					title: q.title,
					...(q.options ? { options: q.options } : {}),
					...(q.images?.length ? { images: q.images } : {}),
					...(q.blankCount !== undefined ? { blankCount: q.blankCount } : {})
				});
				// 图片下载走 server（context.request 共享 cookie，ADR-0019 §2）
				for (const url of q.images ?? []) {
					const bin = await browser.requestBinary(url, run.frameUrl || undefined);
					if (!bin) {
						content.push(text(`[图片获取失败] ${url}（题目 ${q.id}）`));
						continue;
					}
					if (bin.buffer.byteLength > MAX_IMAGE_BYTES) {
						content.push(text(`[图片过大跳过 ${(bin.buffer.byteLength / 1024 / 1024).toFixed(1)}MB] ${url}`));
						continue;
					}
					content.push(
						imageBlock(bin.buffer.toString('base64'), bin.mimeType.startsWith('image/') ? bin.mimeType : 'image/png')
					);
				}
			}
			content.unshift(
				text(
					pending.length === 0
						? '当前没有待答题目。注意：空 pending ≠ 完成，请用 get_status 检查 ready_for_review。'
						: `待答题目 ${pending.length} 道（顶层 content 含对应图片，顺序与 structuredContent.questions 一致）。`
				)
			);
			return { content, structuredContent: { questions: structuredQuestions } };
		}
	);

	// ---------- submit_answer ----------
	server.registerTool(
		'submit_answer',
		{
			title: '回填单题答案',
			description:
				'回填单个题目答案。填空 string[] → JSON 编码；纯 string 按分隔符语义（单空含分隔符必须用 string[]）；null = 跳过。',
			inputSchema: {
				run_id: z.string().describe('run id'),
				question_id: z.string().describe('题目 id（get_pending_questions 返回）'),
				answer: answerSchema
			}
		},
		async ({
			run_id,
			question_id,
			answer
		}: {
			run_id: string;
			question_id: string;
			answer: string | string[] | null;
		}): Promise<ToolResult> => {
			return submitOne(run_id, question_id, answer);
		}
	);

	// ---------- submit_answers ----------
	server.registerTool(
		'submit_answers',
		{
			title: '批量回填答案',
			description: '批量回填答案（submit_answer 的批量版）；逐题独立成功/失败，部分失败不影响其余。',
			inputSchema: {
				run_id: z.string().describe('run id'),
				answers: z
					.array(z.object({ question_id: z.string().describe('题目 id'), answer: answerSchema }))
					.describe('答案列表')
			}
		},
		async ({
			run_id,
			answers
		}: {
			run_id: string;
			answers: Array<{ question_id: string; answer: string | string[] | null }>;
		}): Promise<ToolResult> => {
			const results: Array<Record<string, unknown>> = [];
			for (const item of answers) {
				try {
					await submitOne(run_id, item.question_id, item.answer, true);
					results.push({ question_id: item.question_id, ok: true });
				} catch (err) {
					results.push({
						question_id: item.question_id,
						ok: false,
						error: err instanceof Error ? err.message : String(err)
					});
				}
			}
			const allOk = results.every((r) => r.ok);
			return {
				...(allOk ? {} : { isError: true }),
				content: [text(JSON.stringify(results))],
				structuredContent: { results }
			};
		}
	);

	async function submitOne(
		runId: string,
		questionId: string,
		answer: string | string[] | null,
		quiet = false
	): Promise<ToolResult> {
		const run = rm.getRun(runId);
		if (!run) throw new McpToolError(`run ${runId} 不存在。`);
		const q = run.questions.get(questionId);
		if (!q) throw new McpToolError(`题目 ${questionId} 不存在于 run。`);
		if (isTerminalQuestion(q.status)) {
			throw new McpToolError(`题目 ${questionId} 已到达终态（${q.status}），不能重复回填。`);
		}
		if (answer !== null && typeof answer === 'string') {
			const invalid = validateCompletionString(answer, q.blankCount);
			if (invalid) {
				throw new McpToolError(invalid);
			}
		}
		const encoded = encodeAnswer({ type: q.type, answer, blankCount: q.blankCount });
		if (!encoded.ok) {
			throw new McpToolError(`${encoded.message}（code=${encoded.code}）`);
		}
		rm.submitAnswer(runId, questionId, answer, encoded.encoded);
		await router.pushAnswer(runId, questionId, encoded.encoded);
		if (!quiet) log.info(`[tool] submit_answer ${questionId} → ${q.status}`);
		return { content: [text(`已回填（${q.status}）`)], structuredContent: { question_id: questionId, status: q.status } };
	}

	// ---------- submit_paper ----------
	server.registerTool(
		'submit_paper',
		{
			title: '提交试卷',
			description:
				"mode='temporary' 暂存（默认安全态）；mode='confirm' 真正交卷。课程模式 temporary 成功即 saved-and-left 终态（释放遍历）；能力不足返回结构化 unsupported 并保持 run 状态；提交结果不确定先核验，禁止盲目重复提交。",
			inputSchema: {
				run_id: z.string().describe('run id'),
				mode: z.enum(['temporary', 'confirm']).describe('temporary=暂存（默认安全态）；confirm=真正交卷')
			}
		},
		async ({ run_id, mode }: { run_id: string; mode: 'temporary' | 'confirm' }): Promise<ToolResult> => {
			try {
				const outcome = await adapters.executeSubmit(run_id, mode);
				if (outcome.kind === 'unsupported') {
					return toolError(outcome.message, { status: 'unsupported', message: outcome.message });
				}
				if (outcome.kind === 'uncertain') {
					return toolError(
						`提交结果不确定：${outcome.evidence}。禁止盲目重复提交；已标记 submit_uncertain，请先核验页面结果。`,
						{ status: 'uncertain', evidence: outcome.evidence, run_status: outcome.run.status }
					);
				}
				if (outcome.kind === 'failed') {
					return toolError(`保存/提交失败，run 已退回 ready_for_review：${outcome.evidence}`, {
						status: 'failed',
						evidence: outcome.evidence,
						run_status: outcome.run.status
					});
				}
				return {
					content: [text(`提交成功：${outcome.run.status}（${outcome.evidence}）`)],
					structuredContent: { status: outcome.run.status, evidence: outcome.evidence, run_id: outcome.run.id }
				};
			} catch (err) {
				if (err instanceof McpUnsupportedError) {
					return toolError(err.message, { status: 'unsupported', capability: err.capability });
				}
				if (err instanceof McpToolError) return toolError(err.message);
				throw err;
			}
		}
	);

	// ---------- abort_run ----------
	server.registerTool(
		'abort_run',
		{
			title: '终止 run',
			description:
				"终止 run：取消所有等待、向页面传播取消 signal 终止 DOM 写入。reason='manual-saved' 表示人工保存完成（终态 released），否则记 aborted。",
			inputSchema: {
				run_id: z.string().describe('run id'),
				reason: z.string().optional().describe("终止原因；'manual-saved' 表示人工保存完成（终态 released）")
			}
		},
		async ({ run_id, reason }: { run_id: string; reason?: string }): Promise<ToolResult> => {
			const run = await adapters.executeAbort(run_id, reason);
			return {
				content: [text(`run 已终止：${run.status}`)],
				structuredContent: { run_id: run.id, status: run.status }
			};
		}
	);
}
