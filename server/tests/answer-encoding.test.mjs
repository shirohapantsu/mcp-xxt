/**
 * 答案编码单元测试（开发文档 §8.2 四类兼容验证 + ADR-0021 §2 用例）
 * 运行：npm run build && node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAnswer, validateCompletionString, ANSWER_SEPARATORS } from '../dist/answer-encoding.js';

test('双空填空数组 → JSON 编码', () => {
	const r = encodeAnswer({ type: 'completion', answer: ['alpha', 'beta'], blankCount: 2 });
	assert.ok(r.ok);
	// splitAnswer 的 JSON 分支可无损还原
	const parsed = JSON.parse(r.encoded);
	assert.deepEqual(parsed, ['alpha', 'beta']);
});

test('含分隔符的单空答案数组（["a===b","c"] 场景 → ["a===b"]）不被错拆', () => {
	const r = encodeAnswer({ type: 'completion', answer: ['a===b'], blankCount: 1 });
	assert.ok(r.ok);
	assert.equal(r.encoded, '["a===b"]');
	// 验证 splitAnswer JSON 分支还原后仍是一项
	const parsed = JSON.parse(r.encoded);
	assert.deepEqual(parsed, ['a===b']);
});

test('["C#"] 不被分隔符静默错填（ADR-0021 关键用例）', () => {
	const r = encodeAnswer({ type: 'completion', answer: ['C#'], blankCount: 1 });
	assert.ok(r.ok);
	assert.equal(r.encoded, '["C#"]');
	const parsed = JSON.parse(r.encoded);
	assert.deepEqual(parsed, ['C#']);
});

test('多选纯字母数组 → 拼接为 "ABD"', () => {
	const r = encodeAnswer({ type: 'multiple', answer: ['A', 'B', 'D'], blankCount: undefined });
	assert.ok(r.ok);
	assert.equal(r.encoded, 'ABD');
});

test('多选选项全文数组 → JSON 编码', () => {
	const r = encodeAnswer({ type: 'multiple', answer: ['计算机网络', '操作系统'] });
	assert.ok(r.ok);
	assert.equal(r.encoded, JSON.stringify(['计算机网络', '操作系统']));
});

test('多选纯字母字符串 "ABD" 原样透传', () => {
	const r = encodeAnswer({ type: 'multiple', answer: 'ABD' });
	assert.ok(r.ok);
	assert.equal(r.encoded, 'ABD');
});

test('单空填空 string 含分隔符 → 结构化错误', () => {
	const r = encodeAnswer({ type: 'completion', answer: 'C#', blankCount: 1 });
	assert.ok(!r.ok);
	assert.equal(r.code, 'separator-in-single-blank');
});

test('纯 string 填空（按分隔符表达多空）透传', () => {
	const r = encodeAnswer({ type: 'completion', answer: '听党指挥===能打胜仗', blankCount: 2 });
	assert.ok(r.ok);
	assert.equal(r.encoded, '听党指挥===能打胜仗');
});

test('空项在工具层拒绝', () => {
	const r = encodeAnswer({ type: 'completion', answer: ['a', ''], blankCount: 2 });
	assert.ok(!r.ok);
	assert.equal(r.code, 'empty-answer-item');
});

test('空字符串拒绝（null 才是跳过）', () => {
	const r = encodeAnswer({ type: 'single', answer: '  ' });
	assert.ok(!r.ok);
	assert.equal(r.code, 'empty-answer');
});

test('null = 跳过', () => {
	const r = encodeAnswer({ type: 'single', answer: null });
	assert.ok(r.ok);
	assert.equal(r.encoded, null);
});

test('单选数组单项 → 取该项；多项 → 结构化错误', () => {
	const ok = encodeAnswer({ type: 'single', answer: ['选项A'] });
	assert.ok(ok.ok);
	assert.equal(ok.encoded, '选项A');
	const bad = encodeAnswer({ type: 'single', answer: ['A', 'B'] });
	assert.ok(!bad.ok);
	assert.equal(bad.code, 'array-not-allowed');
});

test('validateCompletionString：分隔符拆分数量校验', () => {
	assert.equal(validateCompletionString('a===b', 2), null);
	assert.match(validateCompletionString('a===b===c', 2), /不一致/);
	assert.match(validateCompletionString('a', 2), /string\[\] 按空提交/);
	assert.equal(validateCompletionString('a', 1), null);
	// 未知 blankCount 不校验
	assert.equal(validateCompletionString('anything', undefined), null);
});

test('分隔符集合与 core splitAnswer 默认一致', () => {
	assert.deepEqual([...ANSWER_SEPARATORS], ['===', '#', '---', '###', '|', ';', '；']);
});
