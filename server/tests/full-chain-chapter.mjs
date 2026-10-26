/**
 * 章节测验全链测试（开发文档 §4 典型流程 · §8.2 P2 验收项「ready_for_review → saved → 遍历继续」）：
 *
 *   open_login → open_page(课程学习页) → wait_next_work(work-ready) → get_pending_questions
 *   → 【agent 中途给答案：本脚本把题目写到 tests/.full-chain/questions.json，轮询
 *      tests/.full-chain/answers.json 回填（模拟 MCP answerer 的 agent 角色）】
 *   → submit_answers → get_status 轮询至 ready_for_review
 *   → submit_paper('temporary')（期待课程模式 saved-and-left）
 *   → wait_next_work 验证遍历继续 / course-finished。
 *
 * 安全边界（§8.3）：只做 temporary 暂存，绝不 confirm；命中考试场景立即 abort。
 * 运行：node tests/full-chain-chapter.mjs（在 server/ 目录下）
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKDIR = path.join(__dirname, '.full-chain');
const QUESTIONS_FILE = path.join(WORKDIR, 'questions.json');
const ANSWERS_FILE = path.join(WORKDIR, 'answers.json');
const IMG_DIR = path.join(WORKDIR, 'img');
const REPORT_FILE = path.join(WORKDIR, 'report.json');

const COURSE_URL =
	'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=1249930684&courseId=267298804&clazzid=155243931&cpi=508143193&enc=8fcf7639cfb4a7411988de939dbd9546&mooc2=1&hidetype=0&fanyaVersion=0&openc=1611db8e9d874237e377d37667e68559';

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
	return {
		isError: res.isError === true,
		structured: res.structuredContent ?? {},
		content: res.content ?? []
	};
}

async function main() {
	mkdirSync(WORKDIR, { recursive: true });
	for (const f of [QUESTIONS_FILE, ANSWERS_FILE, REPORT_FILE]) {
		if (existsSync(f)) rmSync(f);
	}
	mkdirSync(IMG_DIR, { recursive: true });
	for (const f of (await import('node:fs')).readdirSync(IMG_DIR)) rmSync(path.join(IMG_DIR, f));

	const transport = new StdioClientTransport({
		command: 'node',
		args: ['dist/index.js'],
		stderr: 'inherit',
		env: { ...process.env }
	});
	const client = new Client({ name: 'mcp-xxt-full-chain', version: '0.0.1' });
	await client.connect(transport);
	console.log(`[${ts()}] MCP 已连接（server: node dist/index.js）`);

	let runId = null;
	try {
		// ---------- 1. 登录 ----------
		let r = await call(client, 'open_login', {}, 120_000);
		console.log(`[${ts()}] open_login → ${JSON.stringify(r.structured)}`);
		if (r.structured.status === 'need-human' || r.structured.status === 'failed') {
			const img = r.content.find((c) => c.type === 'image');
			if (img) writeFileSync(path.join(WORKDIR, 'login.png'), Buffer.from(img.data, 'base64'));
			checkpoint('login', false, `open_login=${r.structured.status}（截图 ${WORKDIR}/login.png）`);
			throw new Error('登录转人工/失败，终止');
		}
		r = await call(client, 'get_login_status');
		checkpoint('login', r.structured.loggedIn === true, `get_login_status=${JSON.stringify(r.structured)}`);
		if (!r.structured.loggedIn) throw new Error('未登录');

		// ---------- 2. 打开课程学习页 ----------
		r = await call(client, 'open_page', { url: COURSE_URL }, 90_000);
		console.log(`[${ts()}] open_page → ${JSON.stringify(r.structured)}`);
		const sessionId = r.structured.session_id;
		checkpoint('open-page', !!sessionId, `session_id=${sessionId ?? '无'} title=${r.structured.title}`);
		if (!sessionId) throw new Error('未命中课程学习页（无 session_id）');

		// ---------- 3. wait_next_work → work-ready ----------
		let workResp = null;
		for (let i = 0; i < 6; i++) {
			r = await call(client, 'wait_next_work', { timeout_s: 45, request_id: `full-chain-${i}` }, 60_000);
			console.log(`[${ts()}] wait_next_work#${i} → ${JSON.stringify(r.structured)}`);
			if (r.structured.event !== 'still-waiting') { workResp = r.structured; break; }
		}
		if (!workResp) { checkpoint('work-ready', false, '6 轮 wait 仍 still-waiting'); throw new Error('未等到 work-ready'); }
		if (workResp.event !== 'work-ready') {
			checkpoint('work-ready', false, `event=${workResp.event} reason=${workResp.reason ?? ''}`);
			throw new Error(`遍历终止：${workResp.event}`);
		}
		runId = workResp.run_id;
		r = await call(client, 'get_status', { run_id: runId });
		const st0 = r.structured;
		console.log(`[${ts()}] run=${runId} job=${st0.job_name} identity=${JSON.stringify(st0.identity)} caps=${JSON.stringify(st0.capabilities)}`);
		if (/考试|exam/i.test(String(st0.job_name ?? ''))) {
			await call(client, 'abort_run', { run_id: runId, reason: 'full-chain: 考试场景不在测试范围' });
			checkpoint('work-ready', false, '命中考试场景（§8 考试暂不测试），已 abort');
			throw new Error('考试场景');
		}
		checkpoint('work-ready', true, `run=${runId} job=${st0.job_name} mode=${st0.mode} caps=${JSON.stringify(st0.capabilities)}`);
		report.steps.run = { id: runId, job: st0.job_name, identity: st0.identity, mode: st0.mode };

		// ---------- 4. 抓题（等题目注册，导出给 agent） ----------
		let questions = [];
		for (let i = 0; i < 30; i++) {
			r = await call(client, 'get_status', { run_id: runId });
			if ((r.structured.question_count ?? 0) > 0) break;
			if (r.structured.status !== 'running') break; // 无题即完成（异常路径，后面统一处理）
			await sleep(2000);
		}
		r = await call(client, 'get_pending_questions', { run_id: runId }, 120_000);
		questions = r.structured.questions ?? [];
		// 顶层 content 里的 image block 按题目顺序落盘，供 agent 查看
		let blockIdx = 0;
		for (const block of r.content) if (block.type === 'text' && block.text.startsWith('待答题目')) { blockIdx = r.content.indexOf(block) + 1; break; }
		const imgManifest = [];
		for (const q of questions) {
			const imgs = [];
			for (let j = 0; j < (q.images?.length ?? 0); j++) {
				const block = r.content[blockIdx++];
				if (block?.type === 'image') {
					const file = path.join(IMG_DIR, `${q.id.slice(0, 8)}-${j}.png`);
					writeFileSync(file, Buffer.from(block.data, 'base64'));
					imgs.push(file);
				} else {
					imgs.push(`[获取失败] ${block?.text ?? ''}`);
				}
			}
			imgManifest.push({ question_id: q.id, images: imgs });
		}
		writeFileSync(QUESTIONS_FILE, JSON.stringify({ run_id: runId, exported_at: new Date().toISOString(), questions, images: imgManifest }, null, 2));
		checkpoint('questions', questions.length > 0, `题目 ${questions.length} 道（已导出 questions.json，图片 ${imgManifest.flatMap((m) => m.images).filter((p) => !p.startsWith('[')).length} 张）`);
		console.log(`[${ts()}] 题目已导出 → ${QUESTIONS_FILE}（agent 请写 ${ANSWERS_FILE}：{"answers":[{"question_id":"...","answer":"A"|["..."]|null}]}）`);

		// ---------- 5+6. agent 回填（逐题即时提交）+ 等待 ready_for_review ----------
		// worker 逐题推进（答完一题才注册下一题），答案轮询必须持续到 run 离开 running
		const submitted = new Set();
		const knownIds = new Set(questions.map((q) => q.id));
		let review = null;
		const overallDeadline = Date.now() + 600_000; // 整体护栏（题目逐题注册 + agent 作答）
		while (Date.now() < overallDeadline) {
			r = await call(client, 'get_status', { run_id: runId });
			const st = r.structured;
			if (st.status !== 'running') { review = st; break; }
			// 新题注册 → 增量导出给 agent（questions.json 持续更新）
			if ((st.question_count ?? 0) > knownIds.size) {
				const pq = await call(client, 'get_pending_questions', { run_id: runId }, 120_000);
				let blockIdx = 1; // content[0] 是文本摘要，image block 按题目顺序排列
				for (const q of pq.structured.questions ?? []) {
					const isNew = !knownIds.has(q.id);
					for (let j = 0; j < (q.images?.length ?? 0); j++) {
						const block = pq.content[blockIdx++];
						if (isNew && block?.type === 'image') {
							const file = path.join(IMG_DIR, `${q.id.slice(0, 8)}-${j}.png`);
							writeFileSync(file, Buffer.from(block.data, 'base64'));
							imgManifest.push({ question_id: q.id, images: [file] });
						}
					}
					if (isNew) {
						knownIds.add(q.id);
						questions.push(q);
					}
				}
				writeFileSync(QUESTIONS_FILE, JSON.stringify({ run_id: runId, exported_at: new Date().toISOString(), questions, images: imgManifest }, null, 2));
				console.log(`[${ts()}] 新题注册（累计 ${knownIds.size} 道），questions.json 已更新`);
			}
			// 消费 agent 答案文件（每轮全量重解析，容忍半写）
			if (existsSync(ANSWERS_FILE)) {
				try {
					const parsed = JSON.parse(readFileSync(ANSWERS_FILE, 'utf8'));
					for (const item of parsed.answers ?? []) {
						if (submitted.has(item.question_id) || !knownIds.has(item.question_id)) continue;
						const qNow = (st.questions ?? []).find((q) => q.id === item.question_id);
						if (!qNow || qNow.status !== 'pending') continue;
						const sr = await call(client, 'submit_answer', { run_id: runId, question_id: item.question_id, answer: item.answer }, 30_000);
						submitted.add(item.question_id);
						console.log(`[${ts()}] submit_answer ${item.question_id.slice(0, 8)} → ${sr.isError ? 'ERROR ' + JSON.stringify(sr.content[0]?.text ?? '') : sr.structured.status}`);
					}
				} catch { /* 半写状态，下一轮重试 */ }
			}
			const pendingLeft = (st.questions ?? []).filter((q) => q.status === 'pending' && !submitted.has(q.id));
			if (pendingLeft.length > 0) {
				const minDl = Math.min(...pendingLeft.map((q) => q.deadline ?? Infinity));
				console.log(`[${ts()}] 待 agent 答题 ${pendingLeft.length} 道（deadline 余量 ${Math.max(0, ((minDl - Date.now()) / 1000)).toFixed(0)}s）`);
			}
			await sleep(2000);
		}
		{
			r = await call(client, 'get_status', { run_id: runId });
			const st = r.structured;
			const byStatus = {};
			for (const q of st.questions ?? []) byStatus[q.status] = (byStatus[q.status] ?? 0) + 1;
			const answersOk = questions.length > 0 && submitted.size === questions.length &&
				(st.questions ?? []).every((q) => q.status === 'applied' && q.finish === true);
			checkpoint('answers', answersOk, `agent 回填 ${submitted.size}/${questions.length}，状态分布 ${JSON.stringify(byStatus)}`);
			report.steps.answered = byStatus;
		}
		if (!review) { checkpoint('ready-for-review', false, '420s 内未离开 running'); throw new Error('run 卡在 running'); }
		const qLines = (review.questions ?? []).map((q) => `[${q.type}] ${q.status}${q.detail ? `(${q.detail.slice(0, 40)})` : ''} ${String(q.title).slice(0, 30)}`);
		console.log(`[${ts()}] run 状态=${review.status} work_completed=${review.work_completed}`);
		for (const l of qLines) console.log('    ' + l);
		const readyOk = review.status === 'ready_for_review' && review.work_completed === true;
		checkpoint('ready-for-review', readyOk, `status=${review.status} work_completed=${review.work_completed}`);
		if (!readyOk) throw new Error(`异常状态：${review.status}`);

		// ---------- 7. submit_paper(temporary) —— 本次全链核心未验证环节 ----------
		r = await call(client, 'submit_paper', { run_id: runId, mode: 'temporary' }, 150_000);
		console.log(`[${ts()}] submit_paper(temporary) → isError=${r.isError} ${JSON.stringify(r.structured)}`);
		const submitOk = !r.isError && r.structured.status === 'saved-and-left';
		checkpoint('submit-temporary', submitOk, `status=${r.structured.status} evidence=${JSON.stringify(r.structured.evidence ?? '')}${r.isError ? ' err=' + JSON.stringify(r.content[0]?.text ?? '') : ''}`);
		report.steps.submit = r.structured;
		if (!submitOk) throw new Error('temporary 暂存未得到成功确认，停止后续验收并收尾');

		// ---------- 8. 保存后遍历继续 ----------
		r = await call(client, 'wait_next_work', { timeout_s: 40 }, 60_000);
		console.log(`[${ts()}] wait_next_work(保存后) → ${JSON.stringify(r.structured)}`);
		const ev = r.structured.event;
		let contNote = `event=${ev}`;
		if (ev === 'work-ready') {
			const nextRun = r.structured.run_id;
			const ns = await call(client, 'get_status', { run_id: nextRun });
			contNote = `下一个测验就绪（${ns.structured.job_name}），超出本次单链范围 → abort`;
			await call(client, 'abort_run', { run_id: nextRun, reason: 'full-chain: 单链测试范围' });
			checkpoint('traversal-continue', true, contNote);
		} else if (ev === 'course-finished') {
			checkpoint('traversal-continue', true, 'course-finished（课程遍历完成）');
		} else if (ev === 'traversal-blocked' || ev === 'page-invalid') {
			checkpoint('traversal-continue', false, `${ev}: ${r.structured.reason ?? ''}`);
		} else {
			checkpoint('traversal-continue', null, 'still-waiting（未收到后续测验或课程结束事件，尚不能确认遍历恢复）');
		}

		// ---------- 收尾 ----------
		r = await call(client, 'get_status', { run_id: runId });
		report.steps.finalRun = { status: r.structured.status, questions: (r.structured.questions ?? []).map((q) => ({ type: q.type, status: q.status, finish: q.finish })) };
		writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
		const all = Object.values(report.checkpoints);
		console.log(`\n[${ts()}] ========== 全链结果 ==========`);
		for (const [id, c] of Object.entries(report.checkpoints)) console.log(`  ${c.ok === true ? '✓' : c.ok === false ? '✗' : '·'} ${id}: ${c.detail}`);
		console.log(`[${ts()}] 报告 → ${REPORT_FILE}`);
		await client.close();
		process.exit(all.every((c) => c.ok === true) ? 0 : 1);
	} catch (err) {
		console.error(`[${ts()}] 失败：`, err);
		report.error = String(err);
		if (runId) {
			try {
				const final = await call(client, 'get_status', { run_id: runId });
				report.steps.finalRun = final.structured;
			} catch { /* keep original failure */ }
			try { await call(client, 'abort_run', { run_id: runId, reason: 'full-chain: 测试失败收尾' }); } catch { /* ignore */ }
		}
		writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
		try { await client.close(); } catch { /* ignore */ }
		process.exit(1);
	}
}

main().catch((err) => {
	console.error('[full-chain] fatal:', err);
	process.exit(1);
});
