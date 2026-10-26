/**
 * 作业页只读能力探测（不启动 MCP server、不注入 bundle、不填写、不保存）：
 * 检查 /mooc2/work/dowork 页面的保存机制（noSubmit/saveWork/按钮）、题目结构与当前已答状态。
 * 运行：node tests/probe-homework.mjs
 */
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
	console.log('URL:', page.url());

	// 题目可能在主文档或 iframe
	let frame = page.mainFrame();
	let qCount = await frame.locator('.questionLi').count();
	if (!qCount) {
		for (const f of page.frames()) {
			const c = await f.locator('.questionLi').count().catch(() => 0);
			if (c) {
				frame = f;
				qCount = c;
				break;
			}
		}
	}
	console.log('questionLi 数量:', qCount, '所在 frame:', frame.url().slice(0, 90));

	const probe = await frame
		.evaluate(`(() => {
			const d = {};
			d.fns = {
				noSubmit: typeof window.noSubmit === 'function',
				saveWork: typeof window.saveWork === 'function',
				btnBlueSubmit: typeof window.btnBlueSubmit === 'function',
				submitWork: typeof window.submitWork === 'function',
				form1: !!document.form1
			};
			d.buttons = Array.from(document.querySelectorAll('a, button, .btnSave, [onclick], input[type=button]'))
				.map(el => ({ text: (el.textContent || el.value || '').trim().slice(0, 20), onclick: (el.getAttribute('onclick') || '').slice(0, 80), cls: el.className?.toString?.().slice(0, 40), id: el.id }))
				.filter(b => b.text && /保存|暂存|提交/.test(b.text) || /save|submit/i.test(b.onclick || '') || /save|submit/i.test(b.cls || ''))
				.slice(0, 12);
			d.questions = Array.from(document.querySelectorAll('.questionLi')).slice(0, 3).map(q => ({
				typeInput: q.querySelector('input[id^="answertype"], input[name^="type"]')?.value,
				title: (q.querySelector('h3, .mark_name, .Zy_TItle')?.textContent || '').trim().slice(0, 60),
				optionCount: q.querySelectorAll('.answerBg .answer_p, .textDIV, .eidtDiv, ul li').length,
				hasTextarea: q.querySelectorAll('textarea').length
			}));
			d.answeredInputs = Array.from(document.querySelectorAll('input[id^="answer"]')).filter(i => /^answer\\d+$/.test(i.id) && i.value).length;
			d.totalAnswerInputs = document.querySelectorAll('input[id^="answer"]').length;
			d.formAction = document.form1?.action?.slice(0, 120) ?? null;
			d.workStatusText = document.querySelector('.workStatus, .statusInfo, .mark_info')?.textContent?.trim()?.slice(0, 60) ?? null;
			return d;
		})()`)
		.catch(e => ({ error: String(e) }));
	console.log(JSON.stringify(probe, null, 1));

	await page.screenshot({ path: path.join(root, 'tests/.probe-homework.png'), fullPage: false });
	const html = await frame.content().catch(() => '');
	writeFileSync(path.join(root, 'tests/.probe-homework-frame.html'), html.slice(0, 400_000));
	console.log('截图: tests/.probe-homework.png · frame html: tests/.probe-homework-frame.html');
	await context.close();
} catch (err) {
	console.error('probe 失败:', err);
	await context.close();
	process.exit(1);
}
