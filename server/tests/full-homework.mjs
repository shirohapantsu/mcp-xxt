/**
 * 作业页全链测试（开发文档 §4 手动模式 · P2/P3 验收：显式 start、取题、回填、实际填入、
 * 能力报告、暂存、released 释放）：
 *
 *   open_login → open_page(作业URL)（无 session）→ start_work（手动入口，能力探测）
 *   → get_pending_questions → 【agent 中途给答案：questions.json 轮询 answers.json】
 *   → submit_answer 逐题回填（实际写入 DOM）→ 等 ready_for_review
 *   → submit_paper('temporary')（期待手动模式 saved——页面仍占用，非 saved-and-left）
 *   → 【不执行 confirm】→ abort_run(reason='manual-saved') → released（页面释放）
 *
 * 安全边界：绝不调用 mode='confirm'；保存走页面 saveWork（pyFlag=1 暂存）。
 * 运行：DISPLAY=:0 node tests/full-homework.mjs（在 server/ 目录下）
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKDIR = path.join(__dirname, '.full-homework');
const QUESTIONS_FILE = path.join(WORKDIR, 'questions.json');
const ANSWERS_FILE = path.join(WORKDIR, 'answers.json');
const REPORT_FILE = path.join(WORKDIR, 'report.json');

const HOMEWORK_URL =
	'https://mooc1.chaoxing.com/mooc-ans/mooc2/work/dowork?courseId=265265735&classId=150811059&cpi=508143193&workId=56798381&answerId=55993692&standardEnc=6a4f1ced30fb2abef116a5542cf505cc&enc=3ce264825829eaf56765c81ff8714c9a';

const t0 = Date.now();
const ts = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const report = { startedAt: new Date().toISOString(), steps: {}, checkpoints: {} };
const checkpoint = (id, ok, detail) => {
	report.checkpoints[id] = { ok, detail, at: ts() };
	console.log(`[${ts()}] ${ok === true ? '✓' : ok === false ? '✗' : '·'} C-${id}: ${detail}`);
};

async function call(client, name, args = {}, timeoutMs = 60_000) {
	const res = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
	return { isError: res.isError === true, structured: res.structuredContent ?? {}, content: res.content ?? [] };
}

async function main() {
	mkdirSync(WORKDIR, { recursive: true });
	for (const f of [QUESTIONS_FILE, ANSWERS_FILE, REPORT_FILE]) {
		if (existsSync(f)) rmSync(f);
	}

	const transport = new StdioClientTransport({
		command: 'node',
		args: ['dist/index.js'],
		stderr: 'inherit',
		env: { ...process.env }
	});
	const client = new Client({ name: 'mcp-xxt-full-homework', version: '0.0.1' });
	await client.connect(transport);
	console.log(`[${ts()}] MCP 已连接`);

	try {
		// ---------- 1. 登录 ----------
		let r = await call(client, 'open_login', {}, 120_000);
		console.log(`[${ts()}] open_login → ${r.structured.status}`);
		if (r.structured.status !== 'ok') throw new Error('登录未成功：' + r.structured.detail);
		r = await call(client, 'get_login_status');
		checkpoint('login', r.structured.loggedIn === true, JSON.stringify(r.structured));
		if (!r.structured.loggedIn) throw new Error('未登录');

		// ---------- 2. 打开作业页（非课程页：无 session） ----------
		r = await call(client, 'open_page', { url: HOMEWORK_URL }, 90_000);
		console.log(`[${ts()}] open_page → ${JSON.stringify(r.structured).slice(0, 160)}`);
		checkpoint('open-page', !!r.structured.url && !r.structured.session_id, `session_id=${r.structured.session_id ?? '无（正确）'}`);

		// ---------- 3. start_work（手动入口 + 能力探测） ----------
		r = await call(client, 'start_work', {}, 60_000);
		console.log(`[${ts()}] start_work → ${JSON.stringify(r.structured)}`);
		const runId = r.structured.run_id;
		checkpoint('start-work', !!runId, `run=${runId ?? r.content[0]?.text}`);
		if (!runId) throw new Error('start_work 失败');

		r = await call(client, 'get_status', { run_id: runId });
		const caps = r.structured.capabilities;
		report.steps.capabilities = caps;
		checkpoint(
			'capabilities',
			caps && caps.auto_save === true && caps.auto_submit === false,
			`auto_save=${caps?.auto_save} auto_submit=${caps?.auto_submit}（F10 能力探测：saveWork 暂存支持，交卷不支持）`
		);

		// ---------- 4. 答题循环（agent 经 answers.json 供答案） ----------
		const submitted = new Set();
		const knownIds = new Set();
		const questions = [];
		let review = null;
		const overallDeadline = Date.now() + 900_000;
		while (Date.now() < overallDeadline) {
			r = await call(client, 'get_status', { run_id: runId });
			const st = r.structured;
			if (st.status !== 'running') { review = st; break; }
			// 新题注册 → 增量导出
			if ((st.question_count ?? 0) > knownIds.size) {
				const pq = await call(client, 'get_pending_questions', { run_id: runId }, 120_000);
				for (const q of pq.structured.questions ?? []) {
					if (!knownIds.has(q.id)) {
						knownIds.add(q.id);
						questions.push(q);
					}
				}
				writeFileSync(QUESTIONS_FILE, JSON.stringify({ run_id: runId, questions }, null, 2));
				console.log(`[${ts()}] 新题注册（累计 ${knownIds.size} 道），questions.json 已更新`);
			}
			// 消费 agent 答案
			if (existsSync(ANSWERS_FILE)) {
				try {
					const parsed = JSON.parse(readFileSync(ANSWERS_FILE, 'utf8'));
					for (const item of parsed.answers ?? []) {
						if (submitted.has(item.question_id) || !knownIds.has(item.question_id)) continue;
						const qNow = (st.questions ?? []).find((q) => q.id === item.question_id);
						if (!qNow || qNow.status !== 'pending') continue;
						const sr = await call(
							client,
							'submit_answer',
							{ run_id: runId, question_id: item.question_id, answer: item.answer },
							30_000
						);
						if (!sr.isError) submitted.add(item.question_id);
						console.log(`[${ts()}] submit_answer ${item.question_id.slice(0, 8)} → ${sr.isError ? 'ERROR ' + JSON.stringify(sr.content[0]?.text ?? '').slice(0, 120) : sr.structured.status}`);
					}
				} catch { /* 半写状态，下轮重试 */ }
			}
			const pendingLeft = (st.questions ?? []).filter((q) => q.status === 'pending' && !submitted.has(q.id));
			if (pendingLeft.length > 0) {
				console.log(`[${ts()}] 待 agent 答题 ${pendingLeft.length} 道`);
			}
			await sleep(2000);
		}
		{
			const st = review ?? (await call(client, 'get_status', { run_id: runId })).structured;
			const byStatus = {};
			for (const q of st.questions ?? []) byStatus[q.status] = (byStatus[q.status] ?? 0) + 1;
			report.steps.answered = byStatus;
			const answersOk = questions.length > 0 && submitted.size === questions.length &&
				(st.questions ?? []).every((q) => q.status === 'applied' && q.finish === true);
			checkpoint('answers', answersOk, `agent 回填 ${submitted.size}/${questions.length}，状态分布 ${JSON.stringify(byStatus)}`);
		}
		const readyOk = review?.status === 'ready_for_review' && review?.work_completed === true;
		checkpoint('ready-for-review', readyOk, `status=${review?.status} work_completed=${review?.work_completed}`);
		if (!readyOk) throw new Error('未到达 ready_for_review');

		// ---------- 5. 只暂存不交卷 ----------
		r = await call(client, 'submit_paper', { run_id: runId, mode: 'temporary' }, 150_000);
		console.log(`[${ts()}] submit_paper(temporary) → isError=${r.isError} ${JSON.stringify(r.structured)}`);
		const savedOk = !r.isError && r.structured.status === 'saved';
		checkpoint('save-temporary', savedOk, `status=${r.structured.status} evidence=${JSON.stringify(r.structured.evidence ?? '')}（手动模式 saved，页面仍占用，非 saved-and-left）`);
		if (!savedOk) throw new Error('暂存未成功');

		// ---------- 6. 不执行 confirm；人工保存完成 → released 释放页面 ----------
		r = await call(client, 'abort_run', { run_id: runId, reason: 'manual-saved' }, 30_000);
		console.log(`[${ts()}] abort_run(manual-saved) → ${JSON.stringify(r.structured)}`);
		const releasedOk = r.structured.status === 'released';
		checkpoint('released', releasedOk, `终态=${r.structured.status}（人工保存完成语义，互斥释放）`);

		// 互斥已释放：再次 start_work 应能创建新 run（验证后立即 abort 清理）
		r = await call(client, 'start_work', {}, 60_000);
		const mutexOk = !!r.structured.run_id;
		if (mutexOk) {
			await call(client, 'abort_run', { run_id: r.structured.run_id, reason: 'full-homework: 互斥验证后清理' });
		}
		checkpoint('mutex-released', mutexOk, `released 后可再次 start_work（验证 run=${r.structured.run_id ?? '无'}）`);
	} finally {
		try {
			const active = (await call(client, 'get_status', {})).structured;
			if (active.run_id && !['finished', 'saved-and-left', 'released', 'aborted'].includes(active.status)) {
				await call(client, 'abort_run', { run_id: active.run_id, reason: 'full-homework: 收尾' });
				console.log(`[${ts()}] 兜底 abort ${active.run_id.slice(0, 8)}`);
			}
		} catch { /* 忽略 */ }
	}

	const ok = ['login', 'open-page', 'start-work', 'capabilities', 'answers', 'ready-for-review', 'save-temporary', 'released', 'mutex-released']
		.every((k) => report.checkpoints[k]?.ok === true);
	report.summary = { ok };
	writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
	console.log(`\n[${ts()}] ══ 作业全链：${ok ? '通过 ✓' : '未通过'}，报告 → ${REPORT_FILE}`);
	await client.close();
	process.exit(ok ? 0 : 1);
}

main().catch((err) => {
	console.error('失败：', err);
	process.exit(1);
});
