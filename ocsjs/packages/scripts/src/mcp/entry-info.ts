/** MCP 入口的 GM_info 替身（gm-shim 已安装完整结构，此处仅读取展示版本） */
export const GM_INFO_MCP: { version: string; handler: string } = {
	version: ((globalThis as unknown as { GM_info?: { script?: { version?: string } } }).GM_info?.script?.version ??
		'5.2.3-mcp') as string,
	handler: ((globalThis as unknown as { GM_info?: { scriptHandler?: string } }).GM_info?.scriptHandler ?? 'mcp-xxt') as string
};
