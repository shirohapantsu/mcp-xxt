/**
 * 答案输入编码（D15/D19/D20，ADR-0021 §2）
 *
 * `SearchInformation.answer` 为 string（worker 侧会 trim），数组不可直接传入。
 * 工具层做确定性编码：
 * - 填空 string[] → JSON.stringify 编码（复用 splitAnswer 既有的 JSON 解析分支，无损还原；
 *   分隔符 join 会丢失答案边界，如 ["C#"] 被静默错填，已废弃）；
 * - 纯 string 输入语义 = 按分隔符表达多个答案（与原题库一致）；
 *   单空且答案文本含分隔符时必须用 string[]（server 按 blankCount 预校验，违规返回结构化错误）；
 * - 多选 string[]：全为单字母 A-N 时拼接为 "ABD"（纯字母兜底契约）；
 *   否则 JSON.stringify（经 splitAnswer JSON 分支逐项匹配选项全文）；
 * - 空项在工具层拒绝（现有解析器会过滤空项，JSON 编码不解决空位定位问题）。
 */

/** 与 core splitAnswer 默认分隔符一致 */
export const ANSWER_SEPARATORS = ['===', '#', '---', '###', '|', ';', '；'] as const;

export type AnswerInput = string | string[] | null;

export type EncodeResult =
	| { ok: true; encoded: string | null }
	| { ok: false; code: string; message: string };

function containsSeparator(s: string, separators: string[]): boolean {
	return separators.some((sep) => sep.length > 0 && s.includes(sep));
}

function isLetterAnswer(item: string): boolean {
	return /^[A-N]$/.test(item.trim());
}

export function encodeAnswer(input: {
	type: string;
	answer: AnswerInput;
	blankCount?: number;
	separators?: string[];
}): EncodeResult {
	const separators = input.separators && input.separators.length > 0 ? input.separators : [...ANSWER_SEPARATORS];
	const { type, answer } = input;

	// null = 显式跳过（question-result: skipped）
	if (answer === null) {
		return { ok: true, encoded: null };
	}

	if (typeof answer === 'string') {
		if (answer.trim().length === 0) {
			return { ok: false, code: 'empty-answer', message: '答案不能为空字符串；要跳过请提交 null。' };
		}
		// 填空：单空且文本含分隔符 → 拆分后数量与空位数不符，会被静默错填，拒绝并引导改写
		if (type === 'completion' && input.blankCount === 1 && containsSeparator(answer, separators)) {
			return {
				ok: false,
				code: 'separator-in-single-blank',
				message:
					'单空填空的答案文本包含答案分隔符（' +
					separators.join(' ') +
					'），按分隔符语义会被拆成多项导致错填。请改用 string[] 形式提交：["' +
					answer.replace(/["\\]/g, '\\$&') +
					'"]。'
			};
		}
		return { ok: true, encoded: answer };
	}

	// string[] 输入
	if (answer.length === 0) {
		return { ok: false, code: 'empty-answer-array', message: '答案数组不能为空。' };
	}
	const trimmed = answer.map((a) => (typeof a === 'string' ? a.trim() : ''));
	const emptyIdx = trimmed.findIndex((a) => a.length === 0);
	if (emptyIdx !== -1) {
		return {
			ok: false,
			code: 'empty-answer-item',
			message: `答案数组第 ${emptyIdx + 1} 项为空；空项会被解析器过滤导致空位错位，请在工具层拒绝（要跳过请提交 null）。`
		};
	}

	if (type === 'multiple') {
		// 全为单字母 A-N → 拼接为纯字母答案（"ABD"），走 resolveMultiple 纯 ABCD 兜底
		if (trimmed.every(isLetterAnswer)) {
			return { ok: true, encoded: trimmed.map((a) => a.trim()).join('') };
		}
		// 选项全文数组 → JSON 编码，splitAnswer JSON 分支无损还原后逐项匹配选项
		return { ok: true, encoded: JSON.stringify(trimmed) };
	}

	if (type === 'completion') {
		// JSON.stringify 编码（ADR-0021 §2）
		return { ok: true, encoded: JSON.stringify(trimmed) };
	}

	if (type === 'single' || type === 'judgement') {
		if (trimmed.length === 1 && trimmed[0] !== undefined) {
			return { ok: true, encoded: trimmed[0] };
		}
		return {
			ok: false,
			code: 'array-not-allowed',
			message: `${type} 题型只接受单个答案文本（string）；多选题可传选项文本数组。`
		};
	}

	return {
		ok: false,
		code: 'unsupported-type',
		message: `题型 ${type} 在 v1 不支持回填（连线/完形/阅读 unsupported），请跳过。`
	};
}

/**
 * blankCount 预校验（填空 string 输入）：分隔符拆分后的项数应与空位数一致或为单项。
 * 返回 null 表示通过，否则返回结构化错误信息。
 */
export function validateCompletionString(answer: string, blankCount: number | undefined, separators?: string[]): string | null {
	if (blankCount === undefined) return null;
	const seps = separators && separators.length > 0 ? separators : [...ANSWER_SEPARATORS];
	// 含分隔符时按第一个命中的分隔符拆分计数（与 splitAnswer 行为一致）
	for (const sep of seps) {
		if (sep.length > 0 && answer.includes(sep)) {
			const parts = answer.split(sep).filter((p) => p.trim().length > 0);
			if (parts.length !== blankCount) {
				return `按分隔符 "${sep}" 拆分得到 ${parts.length} 项，与空位数 ${blankCount} 不一致；请检查答案或改用 string[] 按空提交。`;
			}
			return null;
		}
	}
	// 不含分隔符：单项；多空时仅第一空被填充，其余为空 → 运行侧 finish=false
	if (blankCount > 1) {
		return `填空共 ${blankCount} 空，但答案是单项且不含分隔符；请用 string[] 按空提交（每空一项）。`;
	}
	return null;
}
