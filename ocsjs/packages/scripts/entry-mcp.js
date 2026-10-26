/* eslint-disable no-undef, max-len */
/// <reference path="./global.d.ts" />

/**
 * MCP 模式入口（F8）：单文件 IIFE，全局名 OCS_MCP。
 *
 * bootstrap 顺序（ADR-0019 §4，不依赖多 init script 顺序）：
 *   GM shim + MCP 模式标记 → frame 本地桥 → 框架 bundle → 框架启动
 *
 * ES import 按声明顺序执行：bootstrap 模块先于框架代码运行，
 * 保证 GM_* shim 与模式标记在任何框架生命周期（onstart/onactive/oncomplete）之前就位。
 */

// 1. shim + 模式标记 + frame 桥
import './src/mcp/bootstrap';

// 2. 样式（单文件打包，替代油猴 STYLE 资源）
import STYLE from './assets/css/style.css?raw';

// 3. 框架 bundle + 启动
import { start, definedProjects, CommonProject, RenderScript, logoSvg } from './src/index';
import { GM_INFO_MCP } from './src/mcp/entry-info';
import { trimPanelsForMCP } from './src/mcp/panel-trim';

(function mcpStart() {
	'use strict';

	// about:blank 瞬态文档（ctx.newPage 初始页 / 动态 iframe 占位）：body 为空会让 easy-us
	// CustomWindow.mount 抛错，且这些文档随后即被导航替换——跳过框架启动（shim 与桥保留，
	// 真实内容的文档会重新执行 bootstrap 与本入口）。
	if (location.protocol === 'about:') {
		console.log('[mcp-xxt] about:blank 跳过框架启动');
		return;
	}

	// F7 面板裁剪：MCP 模式下隐藏题库配置/在线搜题/上游更新/桌面端同步/油猴菜单/媒体配置项
	trimPanelsForMCP();

	const projects = definedProjects();

	start({
		projects: projects,
		renderConfig: {
			renderScript: RenderScript,
			styles: [STYLE],
			defaultPanelName: CommonProject.scripts.guide.namespace,
			title: `${logoSvg} OCS <span style="font-size: 12px; color: #969696;">MCP v${GM_INFO_MCP.version}</span>`
		},
		updatePage: undefined
	});
})();
