#!/usr/bin/env node
/**
 * 同步 ocsjs fork 的 MCP bundle 构建产物到 server/dist-bundle/。
 * 用法：node scripts/sync-bundle.mjs [ocsjs-dist-dir]
 * 默认从 ../ocsjs/packages/scripts/dist-mcp/bundle.iife.js 复制。
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');
const src = process.argv[2] || path.resolve(serverRoot, '../ocsjs/packages/scripts/dist-mcp/bundle.iife.js');
const outDir = path.resolve(serverRoot, 'dist-bundle');
const outFile = path.join(outDir, 'bundle.iife.js');

if (!existsSync(src)) {
	console.error(`[sync-bundle] 源文件不存在：${src}`);
	console.error('[sync-bundle] 请先在 ocsjs fork 运行：node scripts/build-mcp.js');
	process.exit(1);
}
mkdirSync(outDir, { recursive: true });
copyFileSync(src, outFile);
console.log(`[sync-bundle] ${src} -> ${outFile}`);
