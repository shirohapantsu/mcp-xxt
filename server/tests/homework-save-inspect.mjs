/**
 * 作业页只读持久化复核：不注入 bundle、不填写、不保存。
 * 比对平台上已暂存的答案与 tests/.full-homework/answers.json 的回填内容。
 * 运行：node tests/homework-save-inspect.mjs
 */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'tests/.full-homework');
const questions = JSON.parse(readFileSync(path.join(output, 'questions.json'), 'utf8')).questions;
const answers = JSON.parse(readFileSync(path.join(output, 'answers.json'), 'utf8')).answers;
const HOMEWORK_URL =
	'https://mooc1.chaoxing.com/mooc-ans/mooc2/work/dowork?courseId=265265735&classId=150811059&cpi=508143193&workId=56798381&answerId=55993692&standardEnc=6a4f1ced30fb2abef116a5542cf505cc&enc=3ce264825829eaf56765c81ff8714c9a';

const context = await chromium.launchPersistentContext(path.join(root, '.browser-profile'), {
	headless: false,
	bypassCSP: true,
	viewport: { width: 1440, height: 1000 }
});
try {
	const page = await context.newPage();
	await page.goto(HOMEWORK_URL, { waitUntil: 'domcontentloaded' });
	await page.waitForTimeout(8000);
	const frame = page.mainFrame();
	const state = await frame.evaluate(`(() => {
		// 每题的已保存值：input[id^=answer<qid>] 的 value（单选/判断为选项字母；判断题 value 为 true/false）
		const out = [];
		document.querySelectorAll('.questionLi').forEach((q) => {
			const saved = {};
			q.querySelectorAll('input').forEach((input) => {
				if (/^answer\\d+$/.test(input.id)) saved[input.id] = input.value;
			});
			out.push({ saved });
		});
		return out;
	})()`);
	const normalize = (s) => String(s).replace(/\u00a0/g, ' ').replace(/\s+/g, '').replace(/[。．.]/g, '');
	const persistence = state.map((q, index) => {
		const question = questions[index];
		const answer = answers.find((a) => a.question_id === question?.id)?.answer;
		const values = Object.values(q.saved);
		// 期望字母：按 options 序号映射
		let expected;
		if (question?.type === 'judgement') {
			expected = { 对: 'true', 错: 'false' }[answer];
		} else if (Array.isArray(answer)) {
			expected = (question?.options ?? [])
				.map((opt, i) => [normalize(opt), String.fromCharCode(65 + i)])
				.filter(([norm]) => answer.some((ch) => norm.includes(normalize(ch))))
				.map(([, l]) => l)
				.join('');
		} else {
			const idx = (question?.options ?? []).findIndex(
				(opt) => normalize(opt).includes(normalize(answer)) || normalize(answer).includes(normalize(opt))
			);
			expected = idx >= 0 ? String.fromCharCode(65 + idx) : answer;
		}
		const value = values.filter((v) => v && v.length > 0).join('');
		const matches = typeof expected === 'string' && value.includes(expected);
		return { index: index + 1, type: question?.type, value, expected, matches, populated: value.length > 0 };
	});
	writeFileSync(path.join(output, 'save-inspection.json'), JSON.stringify({ inspectedAt: new Date().toISOString(), persistence }, null, 2));
	await page.screenshot({ path: path.join(output, 'saved-homework.png'), fullPage: false });
	console.log(JSON.stringify({ questionCount: persistence.length, allMatch: persistence.every((p) => p.populated && p.matches), persistence }, null, 1));
	assert.ok(persistence.length === questions.length, '题目数一致');
	assert.ok(persistence.every((p) => p.populated && p.matches), '全部答案已持久化且与回填一致');
} finally {
	await context.close();
}
console.log('INSPECT PASS');
