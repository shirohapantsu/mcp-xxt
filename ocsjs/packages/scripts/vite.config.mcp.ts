import { defineConfig } from 'vite';
import dotenv from 'dotenv';

/**
 * MCP bundle 构建配置（F8）：单文件 IIFE（全局 OCS_MCP）。
 *
 * - 入口 entry-mcp.js：bootstrap（shim+模式标记 → frame 桥）→ 框架 bundle → start；
 * - STYLE 经 ?raw 内联（不依赖油猴资源）；
 * - GM_info 由 shim 预置；
 * - minify 关闭（可调试，配合 server 日志排查页面侧问题）。
 */
dotenv.config();

export default defineConfig({
	resolve: {
		alias: {
			'@ocsjs/core': '../core/src/index.ts'
		}
	},
	esbuild: {
		charset: 'utf8'
	},
	build: {
		cssCodeSplit: false,
		outDir: process.env.VITE_MCP_BUILD_PATH || './dist-mcp',
		emptyOutDir: true,
		minify: false,
		lib: {
			entry: './entry-mcp.js',
			name: 'OCS_MCP',
			fileName: () => 'bundle.iife.js',
			formats: ['iife']
		},
		commonjsOptions: {
			include: [/node_modules/, /eus/, /easy-us/]
		}
	}
});
