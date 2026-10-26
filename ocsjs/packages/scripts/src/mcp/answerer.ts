/**
 * MCP answerer（F3，ADR-0004/0016/0020）：
 * 替换题库搜题的查题器——把题目注册进 frame 桥的待答队列并 await server 回填；
 * 返回 SearchInformation[]（name: 'mcp-agent'），core 四题型匹配管线原样复用。
 *
 * - 题目入队（id=uuid、type/title/options/images/blankCount）→ await 回填；
 * - deadline 由 server 权威下发（桥内默认 300s 兜底，与 server 一致）；
 * - 图片题：题目/选项中的图片 URL 以 [图片N] 占位符替换，URL 数组随 question 事件上报，
 *   由 server 经 context.request 下载后以 MCP image block 交给 agent（GM_xmlhttpRequest 不做假实现）。
 */

import { SearchInformation, WorkContext } from '@ocsjs/core';
import { getBridge, MCPQuestionInfo, MCPQuestionType } from './bridge';
import { IMAGE_URL_REGEX } from '../utils/answerer-env';

export interface MCPAnswererOptions {
	titleTransform: (elements: any, ctx: WorkContext<any>) => string | { text: string; images?: string[] };
	/**
	 * 选项文本列表（agent 可读的逐项选项；字母序 A–N 由返回顺序决定）。
	 * completion 题返回空数组，blankCount 另行统计。
	 */
	optionsList?: (elements: any, ctx: WorkContext<any>) => string[];
	/**
	 * 题型推导（在题型判断/入队前调用）：平台脚本的题型来源是页面隐藏 input（answertype/type），
	 * work 为自定义函数时 OCSWorker 不会自动推导 ctx.type，必须在此显式写入 ctx.type。
	 */
	typeTransform?: (elements: any, ctx: WorkContext<any>) => void;
}

/** 图片 URL → [图片N] 占位符（同 URL 复用同编号，按首次出现顺序） */
export function placeholderImages(...textParts: Array<string | undefined>): { texts: string[]; images: string[] } {
	const images: string[] = [];
	const urlToPlaceholder = new Map<string, string>();
	const replace = (text: string | undefined): string => {
		if (!text) return '';
		return text.replace(IMAGE_URL_REGEX, (url) => {
			let p = urlToPlaceholder.get(url);
			if (!p) {
				p = ` [图片${images.length + 1}] `;
				urlToPlaceholder.set(url, p);
				images.push(url);
			}
			return p;
		});
	};
	return { texts: textParts.map(replace), images };
}

/** v1 支持回填的题型（D15）；其余（连线/完形/阅读/未知）注册为 unsupported 跳过 */
const SUPPORTED_TYPES = ['single', 'multiple', 'judgement', 'completion'];

export function createMCPAnswerer(options: MCPAnswererOptions) {
	return async (elements: any, ctx: WorkContext<any>): Promise<SearchInformation[]> => {
		const bridge = window.__OCS_MCP_BRIDGE__;
		if (!bridge) {
			throw new Error('MCP bridge 不存在，无法上报题目');
		}

		const rawTitle = options.titleTransform(elements, ctx);
		const titleResult = typeof rawTitle === 'string' ? { text: rawTitle } : rawTitle;

		// 题型推导（平台脚本题型来自页面隐藏 input，需显式写入 ctx.type）
		options.typeTransform?.(elements, ctx);
		const type = (ctx.type ?? 'unknown') as MCPQuestionType;
		const supported = SUPPORTED_TYPES.includes(type);

		// 选项列表与图片占位符替换
		const optionList = supported && type !== 'completion' ? (options.optionsList?.(elements, ctx) ?? []) : [];
		const titleP = placeholderImages(titleResult.text);
		const optionP = placeholderImages(...optionList);

		const info: Omit<MCPQuestionInfo, 'id'> = {
			type,
			title: titleP.texts[0] ?? '',
			options: optionP.texts.filter((t) => t.trim().length > 0),
			images: [...titleP.images, ...optionP.images.filter((u) => !titleP.images.includes(u))],
			...(type === 'completion' ? { blankCount: (ctx.elements.options ?? []).length } : {})
		};

		if (!supported) {
			// unsupported：跳过不改 DOM，get_status 显示"未作答（题型不支持）"（D15）
			const res = await bridge.registerUnsupportedQuestion(info);
			(ctx as any).mcp = { questionId: res.id, status: res.status };
			return [{ results: [], name: 'mcp-agent', error: 'unsupported-question-type' }];
		}

		const resolution = await bridge.enqueueQuestion(info);
		(ctx as any).mcp = { questionId: resolution.id, status: resolution.status };

		if (resolution.status === 'cancelled') {
			// 取消：抛出让 worker 调度层跳过后续 DOM 写入（F11 写前复查配合）
			throw new Error('MCP run cancelled');
		}
		if (resolution.status === 'answered' && resolution.answer) {
			return [{ results: [{ question: info.title, answer: resolution.answer }], name: 'mcp-agent' }];
		}
		// skipped / timeout：空结果 + 明确 error（worker 判为未完成，流程继续）
		return [
			{
				results: [],
				name: 'mcp-agent',
				error: resolution.status === 'skipped' ? 'mcp-skipped' : 'mcp-timeout'
			}
		];
	};
}

/**
 * 逐题应用结果发射（onResultsUpdate 接入点，ADR-0020 §3）。
 * 状态判定：桥内题面状态（timeout/skipped/unsupported）优先；否则按 resolver 结果
 * finish → applied / !finish → applied-failed。
 */
export function mcpEmitQuestionResult(workResult: {
	resolved?: boolean;
	result?: { finish?: boolean };
	ctx?: { mcp?: { questionId?: string; status?: string } };
}) {
	const bridge = window.__OCS_MCP_BRIDGE__;
	const mcp = workResult.ctx?.mcp;
	if (!bridge || !mcp?.questionId) return;
	const resolutionStatus = mcp.status;
	if (resolutionStatus === 'timeout' || resolutionStatus === 'skipped' || resolutionStatus === 'unsupported') {
		bridge.emitQuestionResult(mcp.questionId, resolutionStatus);
		return;
	}
	if (workResult.resolved) {
		const finish = workResult.result?.finish === true;
		bridge.emitQuestionResult(mcp.questionId, finish ? 'applied' : 'applied-failed', undefined, finish);
	}
}

/** 整卷作答结束发射（doWork 完成点，带 frame 代次） */
export function mcpEmitWorkCompleted() {
	window.__OCS_MCP_BRIDGE__?.emitWorkCompleted();
}
