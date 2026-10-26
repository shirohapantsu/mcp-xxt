# 连接与构建

仅在用户需要连接、安装或排查本项目 MCP 时使用。正常业务流程直接使用客户端已有连接，不重复启动第二个 server，也不运行真实站点验收脚本。

## 定位项目

项目根目录有 `server/package.json`（包名 `mcp-xxt-server`）、`server/src/tools.ts` 和 `ocsjs/packages/scripts/entry-mcp.js`。Skill 随仓库放在 `skills/mcp-xxt/` 时，仓库在 Skill 目录上两级；Skill 被复制安装后，应从当前工作区或用户指定路径定位，不能依赖作者机器上的绝对路径。

## 客户端配置

这是 stdio MCP server，没有 HTTP 服务地址。通用 MCP 客户端配置示例：

```json
{
  "mcpServers": {
    "mcp-xxt": {
      "command": "node",
      "args": ["/绝对路径/mcp-xxt/server/dist/index.js"]
    }
  }
}
```

按客户端实际支持的配置格式填写；上面的 JSON 不能直接当成所有客户端的配置文件。Skill 的依赖声明不代替 MCP 连接配置。现有配置可用时不修改。

## 本地构建

要求 Node.js 20 或更高版本及可用的图形会话。浏览器是有头 Chromium，持久 profile 位于 `server/.browser-profile/`。

当依赖和构建产物缺失时，在仓库根目录按需执行：

```bash
npm --prefix ocsjs install -w packages/core -w packages/scripts
npm --prefix server install
```

在 `ocsjs/` 下执行 `node scripts/build-mcp.js` 构建 IIFE bundle；随后在 `server/` 下执行：

```bash
node scripts/sync-bundle.mjs
npm run build
```

Chromium 未安装时，在 `server/` 下运行 `npx playwright install chromium`。网络受限的镜像配置参考项目 `server/README.md`，不要擅自修改全局 npm 或代理配置。

账号可由用户在 `server/config/account.json` 中配置 `username`、`password`，也可直接在浏览器人工登录。不要读取或展示已有密码、cookie 或 profile 内容来排查普通连接问题。登录验证码始终转人工。

构建后由 MCP 客户端启动 `node /绝对路径/mcp-xxt/server/dist/index.js`。stdout 保留给 MCP 协议，业务日志走 stderr。工具未在当前会话出现时，应报告需要客户端连接或重新加载工具；仅在终端启动 stdio 进程不会自动把工具注册到当前对话。
