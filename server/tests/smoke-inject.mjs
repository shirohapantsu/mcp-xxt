/**
 * 注入链路冒烟测试（P1 验收的自动化部分）：
 * 双端口 = 双 origin（127.0.0.1:18081 / 18082），覆盖：
 *   1. bundle 注入幂等 + MCP 模式标记 + hello 事件（frame 代次）
 *   2. GM shim：存储读写、本 frame 通知（remote=false）
 *   3. 跨源 frame 存储中继：先写值镜像、再 remote=true 通知（ADR-0021 §1）
 *   4. work-detected 确认制（server 建 run 回执）
 *   5. question 入队 → server 登记 → 下行回填 → 桥 resolve
 *   6. abort 取消 signal → 等待中的题目被取消
 *
 * 运行：node tests/smoke-inject.mjs（需已构建 dist 与 dist-bundle/bundle.iife.js，已安装 chromium）
 */
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { BrowserHost } from '../dist/browser.js';
import { EventRouter } from '../dist/inject.js';
import { RunManager } from '../dist/run-manager.js';

const PAGE_A = `<html><body><h1>frame-A</h1><iframe id="child" src="http://127.0.0.1:18082/child"></iframe></body></html>`;
const PAGE_B = `<html><body><h1>frame-B(child)</h1></body></html>`;

function serve(port, html) {
	return new Promise((resolve) => {
		const s = createServer((req, res) => {
			res.writeHead(200, { 'content-type': 'text/html' });
			res.end(html);
		}).listen(port, '127.0.0.1', () => resolve(s));
	});
}

async function main() {
	const serverA = await serve(18081, PAGE_A);
	const serverB = await serve(18082, PAGE_B);

	const rm = new RunManager();
	let routerRef;
	const events = [];
	const browser = new BrowserHost(
		mkdtempSync(path.join(tmpdir(), 'mcp-xxt-smoke-')),
		async (args) => {
			events.push({ type: args.type, payload: args.payload, url: args.frame.url() });
			return routerRef.onEvent(args);
		},
		() => undefined,
		() => undefined
	);
	const router = new EventRouter(browser, rm);
	routerRef = router;

	console.log('[smoke] launching browser...');
	const ctx = await browser.ensureContext();
	const page = await ctx.newPage();
	browser.getPageKey(page);
	await page.goto('http://127.0.0.1:18081/', { waitUntil: 'load' });
	await page.waitForTimeout(2500);

	// ---- 1. 模式标记 + 桥 + hello ----
	const marker = await page.evaluate('globalThis.__OCS_MCP__ === true');
	assert.ok(marker, 'MCP 模式标记存在');
	const bridgeA = await page.evaluate('!!window.__OCS_MCP_BRIDGE__ && typeof window.__OCS_MCP_BRIDGE__.gen === "string"');
	assert.ok(bridgeA, '主 frame 桥已注册');
	const helloMain = events.filter((e) => e.type === 'hello' && e.url.includes('18081'));
	const helloChild = events.filter((e) => e.type === 'hello' && e.url.includes('18082'));
	assert.ok(helloMain.length >= 1, `主 frame hello 到达（${helloMain.length}）`);
	assert.ok(helloChild.length >= 1, `子 frame hello 到达（跨源，${helloChild.length}）`);
	console.log('[smoke] ✓ 模式标记 / 桥 / hello（含跨源子 frame）');

	// 注入幂等：重复 evaluate bootstrap 标记检查
	const idempotent = await page.evaluate('globalThis.__OCS_MCP_BOOTSTRAPPED__ === true');
	assert.ok(idempotent, 'bootstrap 幂等标记');

	// ---- 2. GM shim：本 frame 读写 + remote=false 通知 ----
	await page.evaluate(`(() => {
		window.__got = [];
		window.__lid = GM_addValueChangeListener('k1', (name, oldV, newV, remote) => window.__got.push({ newV, remote }));
		GM_setValue('k1', 'v1');
	})()`);
	const localNotify = await page.evaluate('window.__got');
	assert.equal(localNotify.length, 1, '本 frame 同步分发一次');
	assert.equal(localNotify[0].newV, 'v1');
	assert.equal(localNotify[0].remote, false, '本 frame 写入 remote=false');
	const gotV = await page.evaluate('GM_getValue("k1", "fallback")');
	assert.equal(gotV, 'v1', 'GM_getValue 直通');
	console.log('[smoke] ✓ GM shim 存储 + 本 frame 通知（remote=false）');

	// ---- 3. 跨源中继：主 frame 写 → 子 frame（18082，跨源）收到镜像 + remote=true 通知 ----
	const childFrame = page.frames().find((f) => f.url().includes('18082'));
	assert.ok(childFrame, '子 frame 存在');
	await childFrame.evaluate(`(() => {
		window.__childGot = [];
		GM_addValueChangeListener('k2', (name, oldV, newV, remote) => window.__childGot.push({ newV, remote }));
	})()`);
	await page.evaluate(`GM_setValue('k2', { hello: 'relay' })`);
	await page.waitForTimeout(1500);
	const childGot = await childFrame.evaluate('window.__childGot');
	assert.ok(childGot.length >= 1, `跨源通知到达（${childGot.length}）`);
	assert.equal(childGot.at(-1).remote, true, '跨源通知 remote=true');
	const childValue = await childFrame.evaluate('GM_getValue("k2")');
	assert.deepEqual(childValue, { hello: 'relay' }, '跨源值镜像可读（先写值镜像再通知）');
	console.log('[smoke] ✓ 跨源存储中继（镜像写入 + remote=true）');

	// ---- 4. work-detected 确认制 ----
	const session = rm.createSession(browser.getPageKey(page));
	const childGen = helloChild[0].payload.gen;
	const ack = await childFrame.evaluate(`window.__OCS_MCP_BRIDGE__.notifyWorkDetected({
		identity: { courseId: 'c1', clazzId: 'cl1', chapterId: 'ch1', jobId: 'j1' },
		jobName: '冒烟测验',
		href: location.href
	})`);
	assert.ok(ack.ok, 'work-detected 确认制回执 ok');
	assert.ok(ack.run_id, '回执带 run_id');
	const run = rm.getRun(ack.run_id);
	assert.equal(run.status, 'running');
	console.log('[smoke] ✓ work-detected 确认制（run=' + ack.run_id.slice(0, 8) + '）');

	// ---- 5. question 入队 → 回填 ----
	const childBridgeGen = childGen;
	const qPromise = childFrame.evaluate(`window.__OCS_MCP_BRIDGE__.enqueueQuestion({
		type: 'single', title: '1+1=?', options: ['2', '3'], images: []
	})`);
	await page.waitForTimeout(800);
	// server 侧应已注册题目
	const pending = Array.from(run.questions.values());
	assert.equal(pending.length, 1, '题目已注册（run 侧）');
	assert.equal(pending[0].type, 'single');
	assert.ok(pending[0].deadline > Date.now(), 'deadline 已设置');
	// 模拟 agent 回填
	await router.pushAnswer(ack.run_id, pending[0].id, '2');
	const qResult = await qPromise;
	assert.equal(qResult.status, 'answered');
	assert.equal(qResult.answer, '2');
	console.log('[smoke] ✓ 题目入队 → server 登记 → 下行回填 resolve');

	// ---- 6. 取消 signal ----
	const q2Promise = childFrame.evaluate(`window.__OCS_MCP_BRIDGE__.enqueueQuestion({
		type: 'completion', title: '填空', options: [], blankCount: 1
	})`);
	await page.waitForTimeout(500);
	await router.pushCancel(ack.run_id, 'smoke-abort');
	const q2Result = await q2Promise;
	assert.equal(q2Result.status, 'cancelled', '取消 signal 终止等待');
	console.log('[smoke] ✓ abort 取消 signal → 等待中的题目取消');

	// ---- deadline 下行覆盖 ----
	const q3Promise = childFrame.evaluate(`window.__OCS_MCP_BRIDGE__.enqueueQuestion({
		type: 'judgement', title: '判断', options: ['对', '错']
	})`);
	await page.waitForTimeout(600);
	const q3 = Array.from(run.questions.values()).reverse().find((x) => x.status === 'pending' && x.title === '判断');
	assert.ok(q3, '第三题已注册');
	// bind-run 之后 currentRun 已绑定；发 deadline 下行
	await router.sendToRun(ack.run_id, { kind: 'deadline', question_id: q3.id, deadline: Date.now() + 1000 });
	await router.pushAnswer(ack.run_id, q3.id, null); // skip
	const q3Result = await q3Promise;
	assert.equal(q3Result.status, 'skipped', 'null 回填 = skipped');
	console.log('[smoke] ✓ deadline 下行 + null 跳过');

	await browser.close();
	serverA.close();
	serverB.close();
	console.log('\n[smoke] 全部通过 ✓');
	process.exit(0);
}

main().catch((err) => {
	console.error('[smoke] 失败：', err);
	process.exit(1);
});
