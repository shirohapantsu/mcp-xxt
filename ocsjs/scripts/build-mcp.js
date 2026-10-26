// @ts-check
/**
 * MCP bundle 构建脚本（F8 构建粘合）：
 * 1. 编译样式（style.less → style.css，供 ?raw 内联）；
 * 2. vite build -c vite.config.mcp.ts 产出单文件 IIFE（dist-mcp/bundle.iife.js）。
 *
 * 产物经 mcp-xxt/server 的 scripts/sync-bundle.mjs 同步到 server/dist-bundle/。
 * 用法：node scripts/build-mcp.js
 */
const { exec } = require('child_process');
const path = require('path');
const { build: buildStyle } = require('./build-style');

/** 执行命令并真正等待退出（子进程对象 await 不会等待退出，需自行封装） */
function execWait(command, cwd) {
	return new Promise((resolve, reject) => {
		const p = exec(command, { cwd }, (err) => {
			if (err) reject(err);
			else resolve();
		});
		p.stdout?.pipe(process.stdout);
		p.stderr?.pipe(process.stdout);
	});
}

async function main() {
	console.log('[build-mcp] 编译样式...');
	const fs = require('fs');
	const cssPath = path.join(__dirname, '../packages/scripts/assets/css/style.css');
	try {
		await buildStyle();
	} catch (err) {
		// pnpm 严格隔离下 style.less 对 easy-us 的相对 @import 不成立；
		// 仓库内已提交 style.css 时回退使用（MCP 构建不改上游资产文件，降低 rebase 冲突面）
		if (fs.existsSync(cssPath)) {
			console.warn('[build-mcp] 样式编译失败，回退使用仓库内已提交的 style.css：', err.message || err);
		} else {
			throw err;
		}
	}
	if (!fs.existsSync(cssPath)) {
		throw new Error('style.css 不存在且编译失败');
	}
	console.log('[build-mcp] 构建 MCP bundle (IIFE)...');
	// pnpm 严格隔离：vite bin 在 packages/scripts/node_modules/.bin，不在根 PATH
	await execWait('npx --no-install vite build -c vite.config.mcp.ts', path.join(__dirname, '../packages/scripts'));
	console.log('[build-mcp] 完成：packages/scripts/dist-mcp/bundle.iife.js');
	console.log('[build-mcp] 同步：cd mcp-xxt/server && node scripts/sync-bundle.mjs');
}

main().catch((err) => {
	console.error('[build-mcp] 失败：', err);
	process.exit(1);
});
