/**
 * 真实站点答案填入验证（P2 验收项：实际填入 + 等待中 abort）：
 *   回填一题（任意选项文本）→ 验证 resolver 匹配 + handler DOM 点击（question-result: applied）→
 *   abort_run 验证取消传播。
 *
 * 安全边界：不调用 submit_paper —— 答案只落在页面 DOM（选项点击），平台零持久化；
 * 不校验答案正确性（流水线验证与答案质量无关）。
 * 运行：node tests/real-answer-check.mjs
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BrowserHost, COURSE_STUDY_URL_PATTERN } from '../dist/browser.js';
import { EventRouter } from '../dist/inject.js';
import { RunManager } from '../dist/run-manager.js';
import { openLogin, checkLoginStatus } from '../dist/login.js';
import { encodeAnswer } from '../dist/answer-encoding.js';

const COURSE_URL =
	'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=1249930799&courseId=267298804&clazzid=155243931&cpi=508143193&enc=8fcf7639cfb4a7411988de939dbd9546&mooc2=1&hidetype=0&fanyaVersion=0&openc=1611db8e9d874237e377d37667e68559';

async function main() {
	const rm = new RunManager();
	let routerRef;
	const browser = new BrowserHost(
		mkdtempSync(path.join(tmpdir(), 'mcp-xxt-ans-')),
		async (args) => routerRef.onEvent(args),
		() => undefined,
		() => undefined
	);
	const router = new EventRouter(browser, rm);
	routerRef = router;

	console.log('[ans] 登录...');
	const login = await openLogin(browser, { username: '13133306553', password: 'xxt2006@' });
	console.log('[ans] 登录:', login.status);
	if (!(await checkLoginStatus(browser)).loggedIn) {
		console.log('[ans] 未登录，终止');
		await browser.close();
		process.exit(2);
	}

	const ctx = await browser.ensureContext();
	const page = await ctx.newPage();
	browser.getPageKey(page);
	rm.createSession('pending-page');
	await browser.navigate(page, COURSE_URL);
	const pageKey = browser.getPageKey(page);
	const session = rm.getCurrentSession();
	if (session) rm.rebindSessionPage(session.id, pageKey);
	await page.waitForTimeout(6000);
	console.log('[ans] 命中课程页:', COURSE_STUDY_URL_PATTERN.test(page.url()));

	console.log('[ans] 等待 work-ready...');
	const resp = await rm.waitNextWork(90_000);
	if (resp.event !== 'work-ready') {
		console.log('[ans] 未等到 work-ready:', JSON.stringify(resp));
		await browser.close();
		process.exit(1);
	}
	const run = rm.getRun(resp.run_id);
	console.log('[ans] run:', run.jobName, JSON.stringify(run.identity));

	// 等第一题入队
	let q1;
	for (let i = 0; i < 30 && !q1; i++) {
		await new Promise((r) => setTimeout(r, 1000));
		q1 = Array.from(run.questions.values()).find((x) => x.status === 'pending');
	}
	if (!q1) {
		console.log('[ans] 30s 内无待答题目，终止');
		await browser.close();
		process.exit(1);
	}
	console.log(`[ans] 首题 [${q1.type}]: ${q1.title.slice(0, 50)}... 选项: ${JSON.stringify(q1.options)}`);

	// 回填（任意选项——流水线验证与答案对错无关；不暂存不提交）
	if (!q1.options?.length) {
		console.log('[ans] 首题无选项（可能是 unsupported），终止');
		await router.pushCancel(run.id, 'no-options');
		await browser.close();
		process.exit(1);
	}
	const answer = q1.options[1] ?? q1.options[0];
	const encoded = encodeAnswer({ type: q1.type, answer, blankCount: q1.blankCount });
	console.log('[ans] 回填答案:', JSON.stringify(answer), '→ encoded:', JSON.stringify(encoded.encoded));
	rm.submitAnswer(run.id, q1.id, answer, encoded.encoded);
	await router.pushAnswer(run.id, q1.id, encoded.encoded);

	// 等待页面侧应用结果（question-result 事件由 onResultsUpdate 发出）
	let applied = false;
	for (let i = 0; i < 30; i++) {
		await new Promise((r) => setTimeout(r, 1000));
		const qq = run.questions.get(q1.id);
		if (qq && ['applied', 'applied-failed', 'timeout'].includes(qq.status)) {
			applied = true;
			console.log(`[ans] 逐题结果（${i + 1}s）: ${qq.status} finish=${qq.finish}`);
			break;
		}
	}
	if (!applied) {
		console.log('[ans] 30s 内未收到逐题应用结果');
	}

	// 验证 DOM：该题选项是否被点击选中（只读检查）
	try {
		const runFrame = page.frames().find((f) => f.url().includes('doHomeWorkNew'));
		if (runFrame) {
			const checked = await runFrame.evaluate(
				`(() => {
					const checkedInputs = Array.from(document.querySelectorAll('.TiMu input:checked, .TiMu [aria-checked="true"]'));
					return checkedInputs.length;
				})()`
			).catch(() => 'eval-fail');
			console.log('[ans] 页面已勾选的选项数（DOM 写入证据）:', checked);
		}
	} catch {
		/* ignore */
	}

	// abort：验证取消传播（后续题目的等待被终止，不再有 DOM 写入）
	console.log('[ans] abort_run（取消传播验证）');
	await rm.abortRun(run.id, 'answer-check abort');
	await router.pushCancel(run.id, 'answer-check abort');
	await new Promise((r) => setTimeout(r, 3000));
	const qAfter = Array.from(run.questions.values()).map((q) => `${q.type}:${q.status}`);
	console.log('[ans] abort 后题目状态:', qAfter.join(', '));
	console.log('[ans] run 终态:', run.status);

	console.log('\n[ans] 完成（未保存/未提交任何内容到平台）');
	await new Promise((r) => setTimeout(r, 5000));
	await browser.close();
	process.exit(0);
}

main().catch((err) => {
	console.error('[ans] 失败：', err);
	process.exit(1);
});
