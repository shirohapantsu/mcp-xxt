/**
 * 完整遍历流程验证（开发文档 §4 典型流程 · P3 验收「课程遍历整课跑通」的流程级子集）：
 *
 *   open_login → open_page(课程学习页) → wait_next_work ↻
 *     每个章节测验 run：get_pending_questions → submit_answer(answer=null，跳过，
 *     零答案内容零 DOM 写入) → 等 ready_for_review → submit_paper('temporary')
 *     → saved-and-left（释放遍历）→ 下一个任务点/测验
 *   → course-finished / traversal-blocked（附原因）/ page-invalid / 护栏超时 终止。
 *
 * 安全边界：本题轮不回填任何答案内容（null=跳过是协议内建语义，resolver 不匹配、handler
 * 不执行 DOM 写入）；只做 temporary，绝不 confirm；已暂存的历史答案保持原样。
 *
 * 环境变量：TRAVERSAL_MAX_MINUTES（整体护栏，默认 30）· PER_RUN_TIMEOUT_MS（单测验护栏，默认 480s）
 * 运行：DISPLAY=:0 node tests/full-traversal.mjs（在 server/ 目录下）
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKDIR = path.join(__dirname, '.full-traversal');
const REPORT_FILE = path.join(WORKDIR, 'report.json');

const COURSE_URL =
	'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=1249930684&courseId=267298804&clazzid=155243931&cpi=508143193&enc=8fcf7639cfb4a7411988de939dbd9546&mooc2=1&hidetype=0&fanyaVersion=0&openc=1611db8e9d874237e377d37667e68559';

const OVERALL_MS = (Number(process.env.TRAVERSAL_MAX_MINUTES) || 30) * 60_000;
const PER_RUN_MS = Number(process.env.PER_RUN_TIMEOUT_MS) || 480_000;

const t0 = Date.now();
const ts = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const report = { startedAt: new Date().toISOString(), mode: 'skip-all(null) + temporary', tests: [], termination: null };
const testsPassed = () => report.tests.length > 0 && report.tests.every((t) => t.flow_ok);

async function call(client, name, args = {}, timeoutMs = 60_000) {
	const res = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
	return { isError: res.isError === true, structured: res.structuredContent ?? {}, content: res.content ?? [] };
}

/** 单个章节测验 run 的完整生命周期：跳过所有题 → ready_for_review → temporary */
async function processRun(client, runId, seq) {
	const record = { seq, run_id: runId, started_at: ts(), identity: null, job: null, questions: 0, statusDistribution: {}, temporary: null, flow_ok: false };
	report.tests.push(record);
	console.log(`[${ts()}] ── 测验 #${seq}: run=${runId.slice(0, 8)}`);

	let st = (await call(client, 'get_status', { run_id: runId })).structured;
	record.job = st.job_name;
	record.identity = st.identity;
	console.log(`[${ts()}]    job=${st.job_name} identity=${JSON.stringify(st.identity)} caps=${JSON.stringify(st.capabilities)}`);

	// 跳过所有待答题（null → skipped 终态），直至 ready_for_review / 终态
	const runDeadline = Date.now() + PER_RUN_MS;
	const skipped = new Set();
	while (Date.now() < runDeadline) {
		st = (await call(client, 'get_status', { run_id: runId })).structured;
		record.questions = Math.max(record.questions, st.question_count ?? 0);
		if (st.status !== 'running') break;
		const pending = (st.questions ?? []).filter((q) => q.status === 'pending' && !skipped.has(q.id));
		for (const q of pending) {
			const sr = await call(client, 'submit_answer', { run_id: runId, question_id: q.id, answer: null }, 30_000);
			if (!sr.isError) {
				skipped.add(q.id);
			} else {
				console.log(`[${ts()}]    skip ${q.id.slice(0, 8)} 失败: ${JSON.stringify(sr.content[0]?.text ?? '')}`);
				skipped.add(q.id); // 终态题（answered/timeout）不可重复跳过，避免死循环
			}
		}
		await sleep(1500);
	}
	const byStatus = {};
	for (const q of st.questions ?? []) byStatus[q.status] = (byStatus[q.status] ?? 0) + 1;
	record.statusDistribution = byStatus;
	console.log(`[${ts()}]    状态分布 ${JSON.stringify(byStatus)} run=${st.status}`);

	if (st.status !== 'ready_for_review') {
		console.log(`[${ts()}]    run 未到达 ready_for_review（${st.status}）`);
		if (!['ready_for_review', 'saved-and-left', 'finished'].includes(st.status)) {
			await call(client, 'abort_run', { run_id: runId, reason: 'full-traversal: 未就绪，解锁遍历' }).catch(() => undefined);
		}
		return record;
	}

	// temporary 暂存（课程模式期待 saved-and-left 释放遍历）；失败重试一次，再失败 abort 解锁
	let submitted = await call(client, 'submit_paper', { run_id: runId, mode: 'temporary' }, 150_000);
	console.log(`[${ts()}]    submit_paper(temporary) → isError=${submitted.isError} ${JSON.stringify(submitted.structured)}`);
	if (submitted.isError) {
		console.log(`[${ts()}]    首次暂存未确认成功，重试一次`);
		submitted = await call(client, 'submit_paper', { run_id: runId, mode: 'temporary' }, 150_000);
		console.log(`[${ts()}]    submit_paper(temporary)#2 → isError=${submitted.isError} ${JSON.stringify(submitted.structured)}`);
	}
	record.temporary = submitted.structured.status ?? ('error: ' + JSON.stringify(submitted.content[0]?.text ?? ''));
	const finalRun = (await call(client, 'get_status', { run_id: runId })).structured;
	record.final_status = finalRun.status;
	// 流程判定：到达过 ready_for_review，且 temporary 得到 saved-and-left（或 failed-after-retry
	// 时 run 已被 abort 解锁，流程不中断——记录为 flow_ok=false 但遍历继续）
	record.flow_ok = finalRun.status === 'saved-and-left';
	if (!record.flow_ok) {
		const stNow = (await call(client, 'get_status', { run_id: runId })).structured;
		if (!['saved-and-left', 'finished'].includes(stNow.status)) {
			await call(client, 'abort_run', { run_id: runId, reason: 'full-traversal: 暂存未成功，解锁遍历' }).catch(() => undefined);
		}
	}
	console.log(`[${ts()}]    run 终态=${finalRun.status} flow_ok=${record.flow_ok}`);
	return record;
}

async function main() {
	mkdirSync(WORKDIR, { recursive: true });
	if (existsSync(REPORT_FILE)) rmSync(REPORT_FILE);

	const transport = new StdioClientTransport({
		command: 'node',
		args: ['dist/index.js'],
		stderr: 'inherit',
		env: { ...process.env }
	});
	const client = new Client({ name: 'mcp-xxt-full-traversal', version: '0.0.1' });
	await client.connect(transport);
	console.log(`[${ts()}] MCP 已连接`);

	try {
		// ---------- 1. 登录 ----------
		let r = await call(client, 'open_login', {}, 120_000);
		console.log(`[${ts()}] open_login → ${r.structured.status}`);
		if (r.structured.status !== 'ok') throw new Error('登录未成功：' + r.structured.detail);
		r = await call(client, 'get_login_status');
		console.log(`[${ts()}] get_login_status → ${JSON.stringify(r.structured)}`);
		if (!r.structured.loggedIn) throw new Error('未登录');

		// ---------- 2. 打开课程学习页 ----------
		r = await call(client, 'open_page', { url: COURSE_URL }, 90_000);
		const sessionId = r.structured.session_id;
		console.log(`[${ts()}] open_page → session=${sessionId} title=${r.structured.title}`);
		if (!sessionId) throw new Error('未命中课程学习页');
		report.session_id = sessionId;

		// ---------- 3. 遍历主循环 ----------
		const overallDeadline = Date.now() + OVERALL_MS;
		let seq = 0;
		let requestSeq = 0;
		while (Date.now() < overallDeadline) {
			const resp = await call(
				client,
				'wait_next_work',
				{ timeout_s: 45, request_id: `traversal-${requestSeq++}` },
				60_000
			);
			const ev = resp.structured;
			if (ev.event === 'still-waiting') {
				console.log(`[${ts()}] still-waiting（任务点跳转中）`);
				continue;
			}
			if (ev.event === 'work-ready') {
				seq++;
				await processRun(client, ev.run_id, seq);
				continue;
			}
			// course-finished / traversal-blocked / page-invalid
			report.termination = { event: ev.event, reason: ev.reason ?? '', at: ts() };
			console.log(`[${ts()}] 遍历终止：${ev.event} ${ev.reason ?? ''}`);
			break;
		}
		if (!report.termination) {
			report.termination = { event: 'watchdog-timeout', reason: `${OVERALL_MS / 60000} 分钟护栏到期`, at: ts() };
			console.log(`[${ts()}] 整体护栏到期，收尾`);
		}
	} finally {
		// 兜底：解除可能仍占用的互斥（保持浏览器运行以便人工观察可注释掉）
		try {
			const active = (await call(client, 'get_status', {})).structured;
			if (active.run_id && !['finished', 'saved-and-left', 'released', 'aborted'].includes(active.status)) {
				await call(client, 'abort_run', { run_id: active.run_id, reason: 'full-traversal: 收尾' });
				console.log(`[${ts()}] 兜底 abort ${active.run_id.slice(0, 8)}`);
			}
		} catch { /* client 已关闭等 */ }
	}

	// ---------- 4. 汇总 ----------
	report.summary = {
		tests: report.tests.length,
		flow_ok: testsPassed(),
		termination: report.termination
	};
	writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
	console.log(`\n[${ts()}] ══ 遍历汇总：测验 ${report.tests.length} 个，流程全部通过=${testsPassed()}，终止=${report.termination.event}`);
	console.log(`[${ts()}] 报告 → ${REPORT_FILE}`);
	await client.close();
	process.exit(testsPassed() && ['course-finished', 'traversal-blocked', 'page-invalid'].includes(report.termination?.event) ? 0 : 1);
}

// existsSync import
import { existsSync } from 'node:fs';

main().catch(async (err) => {
	console.error(`[${ts()}] 遍历失败：`, err);
	process.exit(1);
});
