/**
 * 面板裁剪（F7，ADR-0006/0009）：MCP 模式下隐藏与 MCP 工作流无关/有害的面板入口，
 * 保留人类监督窗（render/workResults/console/errorHandle/hack/disableDialog）。
 *
 * 仅隐藏（hideInPanel），不删除脚本/源码（ADR-0009 禁用而非删除）；
 * 配置读取（如 getWorkOptions）不受 hideInPanel 影响。
 */

import { CommonProject } from '../projects/common';
import { BackgroundProject } from '../projects/background';
import { CXProject } from '../projects/cx';
import { isMCPMode } from './mode';

export function trimPanelsForMCP() {
	if (!isMCPMode()) return;
	const hide = (script: { hideInPanel?: boolean } | undefined) => {
		if (script) script.hideInPanel = true;
	};

	// 题库配置 UI（MCP answerer 旁路题库体系）
	hide(CommonProject.scripts.settings);
	// 在线搜题
	hide(CommonProject.scripts.onlineSearch);
	// 上游更新
	hide(BackgroundProject.scripts.update);
	// 桌面端（软件配置）同步
	hide(BackgroundProject.scripts.appConfigSync);
	// 油猴菜单
	hide(BackgroundProject.scripts.menus);
	// 媒体类配置项随学习脚本面板隐藏（媒体行为已被 F5 硬禁用）
	hide(CXProject.scripts.study);
	hide(CXProject.scripts.autoRead);
}
