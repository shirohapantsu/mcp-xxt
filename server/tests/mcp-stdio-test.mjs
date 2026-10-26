/**
 * MCP stdio 协议层端到端测试：以 MCP 客户端身份连接 server，验证工具清单与基础调用。
 * 运行：node tests/mcp-stdio-test.mjs（会真实启动浏览器与登录页检查，只读操作）
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import assert from 'node:assert';

async function main() {
	const transport = new StdioClientTransport({
		command: 'node',
		args: ['dist/index.js'],
		stderr: 'inherit',
		// 有头浏览器需要 DISPLAY：显式继承当前进程环境
		env: { ...process.env }
	});
	const client = new Client({ name: 'mcp-xxt-test', version: '0.0.1' });
	await client.connect(transport);
	console.log('[mcp] connected');

	const tools = await client.listTools();
	const names = tools.tools.map((t) => t.name).sort();
	console.log('[mcp] tools:', names.join(', '));
	assert.deepEqual(
		new Set(names),
		new Set([
			'abort_run',
			'get_login_status',
			'get_pending_questions',
			'get_status',
			'open_login',
			'open_page',
			'start_work',
			'submit_answer',
			'submit_answers',
			'submit_paper',
			'wait_next_work'
		]),
		'11 个工具齐全'
	);

	// get_login_status：只读（首次调用触发浏览器启动）
	const status = await client.callTool({ name: 'get_login_status', arguments: {} });
	console.log('[mcp] get_login_status →', JSON.stringify(status.structuredContent));
	assert.ok(status.structuredContent && 'loggedIn' in status.structuredContent);

	// wait_next_work 无 session：应返回 page-invalid 而非挂死
	const w = await client.callTool({ name: 'wait_next_work', arguments: { timeout_s: 2 } });
	console.log('[mcp] wait_next_work（无会话） →', JSON.stringify(w.structuredContent));
	assert.equal(w.structuredContent.event, 'page-invalid');

	// get_status 无 run：no-run
	const gs = await client.callTool({ name: 'get_status', arguments: {} });
	console.log('[mcp] get_status（无 run） →', JSON.stringify(gs.structuredContent));

	await client.close();
	console.log('\n[mcp] 全部通过 ✓');
	process.exit(0);
}

main().catch((err) => {
	console.error('[mcp] 失败：', err);
	process.exit(1);
});
