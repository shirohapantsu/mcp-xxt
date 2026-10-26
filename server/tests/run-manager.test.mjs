/**
 * run-manager 状态机 / 事件游标 / 互斥 / 重进计数 单元测试
 * 运行：npm run build && node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RunManager, McpUnsupportedError } from '../dist/run-manager.js';

function courseRun(mgr, opts = {}) {
	return mgr.handleWorkDetected({
		pageKey: opts.pageKey ?? 'p1',
		sessionId: opts.sessionId,
		frameUrl: 'https://mooc1.chaoxing.com/knowledge/cards?t=1',
		frameGen: opts.gen ?? 'g1',
		payload: {
			identity: { courseId: 'c1', clazzId: 'cl1', chapterId: opts.chapterId ?? 'ch1', jobId: opts.jobId ?? 'j1' },
			jobName: '第一章测验',
			href: 'x'
		}
	});
}

test('work-detected 确认制 → run 创建并返回 work-ready', async () => {
	const mgr = new RunManager();
	const s = mgr.createSession('p1');
	const ack = courseRun(mgr, { sessionId: s.id });
	assert.ok(ack.ok);
	assert.equal(ack.run_id.length, 36);
	const resp = await mgr.waitNextWork(1000);
	assert.equal(resp.event, 'work-ready');
	assert.equal(resp.run_id, ack.run_id);
	// 再次等待不重放
	const resp2 = await mgr.waitNextWork(200);
	assert.equal(resp2.event, 'still-waiting');
});

test('单 run 互斥：活跃 run 时第二次 work-detected 拒绝；确认重试去重', () => {
	const mgr = new RunManager();
	const s = mgr.createSession('p1');
	const ack1 = courseRun(mgr, { sessionId: s.id });
	const ack2 = courseRun(mgr, { sessionId: s.id, gen: 'g2' });
	assert.ok(!ack2.ok);
	// 同 frame 同 job 的活跃 run 确认重试 → 返回同一 run
	const ackRetry = mgr.handleWorkDetected({
		pageKey: 'p1',
		sessionId: s.id,
		frameUrl: 'https://x',
		frameGen: 'g1',
		payload: { identity: { courseId: 'c1', clazzId: 'cl1', chapterId: 'ch1', jobId: 'j1' } }
	});
	assert.ok(ackRetry.ok);
	assert.equal(ackRetry.run_id, ack1.run_id);
});

test('ready_for_review：全部题目终态 且 work-completed', () => {
	const mgr = new RunManager();
	const s = mgr.createSession('p1');
	const ack = courseRun(mgr, { sessionId: s.id });
	const run = mgr.getRun(ack.run_id);
	const q = mgr.registerQuestion(run.id, { id: 'q1', type: 'single', title: '1+1=?', options: ['2', '3'] });
	assert.equal(run.status, 'running');
	mgr.applyQuestionResult(run.id, 'q1', 'applied');
	assert.equal(run.status, 'running'); // 未 work-completed，不迁移
	mgr.markWorkCompleted(run.id, 'g1');
	assert.equal(run.status, 'ready_for_review');
});

test('ready_for_review 不抢跑：匹配失败（applied-failed）也是终态', () => {
	const mgr = new RunManager();
	const s = mgr.createSession('p1');
	const ack = courseRun(mgr, { sessionId: s.id });
	const run = mgr.getRun(ack.run_id);
	mgr.registerQuestion(run.id, { id: 'q1', type: 'multiple', title: '多选', options: ['A', 'B'] });
	mgr.applyQuestionResult(run.id, 'q1', 'applied-failed');
	mgr.markWorkCompleted(run.id, 'g1');
	assert.equal(run.status, 'ready_for_review');
});

test('submit_paper 课程模式 temporary → saved-and-left 终态并释放互斥', async () => {
	const mgr = new RunManager();
	const s = mgr.createSession('p1');
	const ack = courseRun(mgr, { sessionId: s.id });
	const run = mgr.getRun(ack.run_id);
	mgr.registerQuestion(run.id, { id: 'q1', type: 'single', title: 't', options: ['a'] });
	mgr.applyQuestionResult(run.id, 'q1', 'applied');
	mgr.markWorkCompleted(run.id, 'g1');
	await mgr.submitPaper(run.id, 'temporary');
	mgr.applySubmitResult(run.id, 'temporary', true, '页面反馈：保存成功');
	assert.equal(run.status, 'saved-and-left');
	// 终态释放互斥：可以建新 run
	const ack2 = courseRun(mgr, { sessionId: s.id, jobId: 'j2' });
	assert.ok(ack2.ok);
});

test('submit_paper 手动模式 temporary → saved（可再 confirm）', async () => {
	const mgr = new RunManager();
	const run = mgr.createManualRun({ pageKey: 'p1', frameUrl: 'u', frameGen: 'g', href: 'u' });
	// 未来能力探测扩展后的场景（v1 作业 auto_save=false 返回 unsupported，见上一用例）
	run.capabilities.auto_save = true;
	run.capabilities.auto_submit = true;
	mgr.markWorkCompleted(run.id, 'g');
	assert.equal(run.status, 'ready_for_review');
	await mgr.submitPaper(run.id, 'temporary');
	mgr.applySubmitResult(run.id, 'temporary', true, 'ok');
	assert.equal(run.status, 'saved');
	await mgr.submitPaper(run.id, 'confirm');
	mgr.applySubmitResult(run.id, 'confirm', true, 'ok');
	assert.equal(run.status, 'finished');
});

test('能力不足 → 结构化 unsupported，run 状态不变', async () => {
	const mgr = new RunManager();
	const run = mgr.createManualRun({ pageKey: 'p1', frameUrl: 'u', frameGen: 'g', href: 'u' });
	mgr.markWorkCompleted(run.id, 'g');
	await assert.rejects(() => mgr.submitPaper(run.id, 'temporary'), McpUnsupportedError);
	assert.equal(run.status, 'ready_for_review');
	await assert.rejects(() => mgr.submitPaper(run.id, 'confirm'), McpUnsupportedError);
	assert.equal(run.status, 'ready_for_review');
});

test('saving 失败退回 ready_for_review', async () => {
	const mgr = new RunManager();
	const run = mgr.createManualRun({ pageKey: 'p1', frameUrl: 'u', frameGen: 'g', href: 'u' });
	run.capabilities.auto_save = true;
	run.capabilities.auto_submit = true;
	mgr.markWorkCompleted(run.id, 'g');
	await mgr.submitPaper(run.id, 'temporary');
	mgr.applySubmitResult(run.id, 'temporary', false, '无明确成功证据');
	assert.equal(run.status, 'ready_for_review');
	assert.equal(run.submitError, '无明确成功证据');
});

test('重复提交/重复回填返回明确错误', async () => {
	const mgr = new RunManager();
	const run = mgr.createManualRun({ pageKey: 'p1', frameUrl: 'u', frameGen: 'g', href: 'u' });
	assert.throws(() => mgr.submitAnswer(run.id, "q1", "a", "a"), /不存在/);
	assert.throws(() => mgr.submitAnswer(run.id, 'q1', 'a', 'a'), /不存在/);
	const q = mgr.registerQuestion(run.id, { id: 'q2', type: 'single', title: 't', options: ['a'] });
	mgr.submitAnswer(run.id, 'q2', 'a', 'a');
	assert.throws(() => mgr.submitAnswer(run.id, 'q2', 'b', 'b'), /重复回填/);
	mgr.applyQuestionResult(run.id, 'q2', 'applied');
	assert.throws(() => mgr.submitAnswer(run.id, 'q2', 'c', 'c'), /重复回填/);
});

test('abort_run：released / aborted 终态', () => {
	const mgr = new RunManager();
	const run = mgr.createManualRun({ pageKey: 'p1', frameUrl: 'u', frameGen: 'g', href: 'u' });
	mgr.abortRun(run.id, 'manual-saved');
	assert.equal(run.status, 'released');
	const run2 = mgr.createManualRun({ pageKey: 'p2', frameUrl: 'u', frameGen: 'g', href: 'u' });
	mgr.abortRun(run2.id, '其他原因');
	assert.equal(run2.status, 'aborted');
});

test('事件游标：超时重试不消耗未交付事件；request_id 缓存已投递响应', async () => {
	const mgr = new RunManager();
	const s = mgr.createSession('p1');
	// 无事件 → still-waiting（不推进游标）
	const w1 = await mgr.waitNextWork(150);
	assert.equal(w1.event, 'still-waiting');
	// 事件到达
	courseRun(mgr, { sessionId: s.id });
	// 重试携带同一 request_id：第一次投递后缓存
	const r1 = await mgr.waitNextWork(1000, 'req-1');
	assert.equal(r1.event, 'work-ready');
	const r2 = await mgr.waitNextWork(1000, 'req-1');
	assert.deepEqual(r2, r1);
	// 不同 request_id → 继续等待下一个事件
	const r3 = await mgr.waitNextWork(150);
	assert.equal(r3.event, 'still-waiting');
});

test('已结束 run 的旧 work-ready 不抢占下一轮等待', async () => {
	const mgr = new RunManager();
	const s = mgr.createSession('p1');
	const ack1 = courseRun(mgr, { sessionId: s.id, jobId: 'j1' });
	// run1 直接终止（人工 saved）
	mgr.abortRun(ack1.run_id, 'manual-saved');
	// run2 就绪
	const ack2 = courseRun(mgr, { sessionId: s.id, jobId: 'j2' });
	const resp = await mgr.waitNextWork(1000);
	assert.equal(resp.event, 'work-ready');
	assert.equal(resp.run_id, ack2.run_id); // 跳过已终态 run1 的 work-ready
});

test('课程终态可恢复；重开课程新 session 不继承', async () => {
	const mgr = new RunManager();
	const s1 = mgr.createSession('p1');
	mgr.emitEvent(s1, null, 'course-finished', { reason: '全部任务点已完成！' });
	const r1 = await mgr.waitNextWork(1000, 'end-1');
	assert.equal(r1.event, 'course-finished');
	assert.equal(s1.terminated, true);
	assert.deepEqual(await mgr.waitNextWork(150, 'end-1'), r1);
	assert.deepEqual(await mgr.waitNextWork(150, 'end-2'), r1);
	assert.deepEqual(await mgr.waitNextWork(150), r1);
	// 重开课程：同页面新 session
	const s2 = mgr.createSession('p1');
	const r3 = await mgr.waitNextWork(150);
	assert.equal(r3.event, 'still-waiting'); // 新 session 无事件
});

test('重进计数身份化：同章节不同测验不累计；取得进展即重置', () => {
	const mgr = new RunManager();
	const s = mgr.createSession('p1');
	// 同一测验进入 2 次（不同 frame gen）
	const a1 = courseRun(mgr, { sessionId: s.id, jobId: 'j1', gen: 'g1' });
	mgr.abortRun(a1.run_id, 'aborted');
	const a2 = courseRun(mgr, { sessionId: s.id, jobId: 'j1', gen: 'g2' });
	mgr.abortRun(a2.run_id, 'aborted');
	// 同章节不同测验不累计（j2 从未进入过）
	const b1 = courseRun(mgr, { sessionId: s.id, jobId: 'j2', gen: 'g4' });
	assert.ok(b1.ok);
	mgr.abortRun(b1.run_id, 'aborted');
	// 第 3 次 → blocked
	const a3 = courseRun(mgr, { sessionId: s.id, jobId: 'j1', gen: 'g3' });
	assert.ok(!a3.ok);
	assert.match(a3.reason, /闯关受阻/);
	assert.equal(s.terminated, true);
	assert.equal(courseRun(mgr, { sessionId: s.id, jobId: 'j2', gen: 'g5' }).ok, false);
	// 另一个 session 中取得进展后重置该测验的计数。
	const s2 = mgr.createSession('p1');
	const firstAttempt = courseRun(mgr, { sessionId: s2.id, gen: 'g6' });
	mgr.abortRun(firstAttempt.run_id, 'aborted');
	const progressed = courseRun(mgr, { sessionId: s2.id, gen: 'g7' });
	const run = mgr.getRun(progressed.run_id);
	mgr.applySubmitResult(run.id, 'temporary', true, 'ok');
	const a4 = courseRun(mgr, { sessionId: s2.id, jobId: 'j1', gen: 'g8' });
	assert.ok(a4.ok);
	assert.equal(s2.terminated, false);
});

test('frame 重生：绑定该 frame 的未终态 run → aborted', () => {
	const mgr = new RunManager();
	mgr.createSession('p1');
	const ack = courseRun(mgr, { sessionId: mgr.getCurrentSession().id });
	const run = mgr.getRun(ack.run_id);
	const aborted = mgr.handleRunFrameLost(run.id, run.pageKey, run.frameGen);
	// 上层已按 Frame 引用核对，管理器再核对 run / page / document 代次
	assert.ok(aborted);
	assert.equal(aborted.id, run.id);
	assert.equal(run.status, 'aborted');
});

test('deadline 兜底：页面不可达的题目标记 timeout', () => {
	const mgr = new RunManager();
	const run = mgr.createManualRun({ pageKey: 'pX', frameUrl: 'u', frameGen: 'g', href: 'u' });
	const q = mgr.registerQuestion(run.id, { id: 'q9', type: 'single', title: 't', options: ['a'] });
	// 强制过期
	q.deadline = Date.now() - 60_000;
	mgr.sweepDeadlines((pageKey) => pageKey !== 'pX', async () => true);
	assert.equal(q.status, 'timeout');
	// 迟到的 applied 可覆盖 timeout（页面是应用事实的来源）
	mgr.applyQuestionResult(run.id, 'q9', 'applied');
	assert.equal(q.status, 'applied');
});
