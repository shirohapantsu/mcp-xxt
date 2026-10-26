/** Read-only verification after full-chain-chapter: no bundle, answer writes, or save/submit calls. */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'tests/.full-chain');
const report = JSON.parse(readFileSync(path.join(output, 'report.json'), 'utf8'));
const questions = JSON.parse(readFileSync(path.join(output, 'questions.json'), 'utf8'));
const answers = JSON.parse(readFileSync(path.join(output, 'answers.json'), 'utf8')).answers;
const source = readFileSync(path.join(root, '../docs/开发文档.md'), 'utf8');
const originalUrl = source.match(/https:\/\/mooc1\.chaoxing\.com\/mycourse\/studentstudy\?[^\s|]+/)[0];
const url = new URL(originalUrl);
url.searchParams.set('chapterId', report.steps.run.identity.chapterId);
const context = await chromium.launchPersistentContext(path.join(root, '.browser-profile'), {
  headless: false, bypassCSP: true, viewport: { width: 1440, height: 1000 }
});
try {
  const page = await context.newPage();
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  const deadline = Date.now() + 30_000;
  let frame;
  while (Date.now() < deadline) {
    for (const candidate of page.frames()) {
      if (await candidate.locator('.TiMu').count().catch(() => 0)) { frame = candidate; break; }
    }
    if (frame) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!frame) throw new Error('No chapter question frame found');
  const state = await frame.evaluate(() => ({
    href: location.href,
    noSubmit: typeof window.noSubmit === 'function' ? String(window.noSubmit) : null,
    btnBlueSubmit: typeof window.btnBlueSubmit === 'function' ? String(window.btnBlueSubmit) : null,
    questions: Array.from(document.querySelectorAll('.TiMu')).map(root => ({
      inputs: Array.from(root.querySelectorAll('input')).map(input => ({
        name: input.name, id: input.id, type: input.type, value: input.value, checked: input.checked
      })),
      selected: Array.from(root.querySelectorAll('.check_answer, .check, .on, [aria-checked="true"]')).map(el => ({
        tag: el.tagName, className: el.className, text: el.textContent?.trim().slice(0, 30)
      }))
    })),
    scripts: Array.from(document.scripts).map(script => script.src || script.textContent)
  }));
  const persistence = state.questions.map((q, index) => {
    const saved = q.inputs.find(input => /^answer\d+$/.test(input.id));
    const question = questions.questions[index];
    const answer = answers.find(answer => answer.question_id === question?.id)?.answer;
    // 平台保存值是「字母/字母串」（选项序号），需要把文本答案映射成字母再比对：
    // - single/multiple：answer（或数组各项）在 options 中的位置 → A/B/C…
    //   （multiple 与已保存状态取并集场景无法只读区分，按子集匹配）
    // - judgement：对/错 → true/false
    const normalize = s => String(s).replace(/\u00a0/g, ' ').replace(/\s+/g, '').replace(/[。．.]/g, '');
    let expected = answer;
    if (question?.type === 'judgement') {
      expected = ({ 对: 'true', 错: 'false' })[answer];
    } else if (Array.isArray(answer) || (question?.type === 'multiple')) {
      const chosen = Array.isArray(answer) ? answer : [answer];
      const letters = (question?.options ?? []).map((opt, i) => [normalize(opt), String.fromCharCode(65 + i)])
        .filter(([norm]) => chosen.some(ch => norm.includes(normalize(ch)) || normalize(ch).includes(norm)))
        .map(([, letter]) => letter);
      expected = letters.join('');
    } else if (typeof answer === 'string' && question?.type === 'single') {
      const idx = (question?.options ?? []).findIndex(opt => normalize(opt).includes(normalize(answer)) || normalize(answer).includes(normalize(opt)));
      expected = idx >= 0 ? String.fromCharCode(65 + idx) : answer;
    }
    const savedValue = saved?.value ?? '';
    // multiple：本次回填应被包含在已保存值中（页面保留此前暂存勾选，resolver 不取消已选项）
    const matches = question?.type === 'multiple'
      ? expected.split('').every(l => savedValue.includes(l))
      : savedValue === expected;
    return { index: index + 1, type: question?.type, value: savedValue,
      expected, matches, populated: !!savedValue };
  });
  writeFileSync(path.join(output, 'save-inspection.json'), JSON.stringify({
    inspectedAt: new Date().toISOString(), questionCount: state.questions.length, persistence, ...state
  }, null, 2));
  await page.screenshot({ path: path.join(output, 'saved-chapter.png'), fullPage: false });
  console.log(JSON.stringify({ questionCount: state.questions.length, persistence,
    noSubmit: state.noSubmit, output }, null, 2));
  assert.equal(persistence.length, questions.questions.length, '重新加载后的题目数应一致');
  assert.ok(persistence.length > 0 && persistence.every(item => item.populated && item.matches),
    '重新加载后的所有答案应与本次回填一致');
} finally {
  await context.close();
}
