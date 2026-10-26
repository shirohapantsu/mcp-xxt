# mcp-xxt server

超星学习通流程化答题的 MCP server：内置 Playwright（有头、持久 profile），注入运行改造后的
ocsjs MCP bundle（单文件 IIFE），以 MCP 工具面（11 个工具）驱动 题目抓取 → agent 作答 → 审核 → 暂存/提交流程。

规范基准：[../docs/开发文档.md](../docs/开发文档.md)（v1.2）；决策存档见 `../docs/adr/`。

## 依赖与安装

版本锁定（P0，见 `package.json` 的 `mcp-xxt` 字段）：

| 包 | 版本 | 说明 |
|---|---|---|
| `@modelcontextprotocol/sdk` | 1.32.2 | MCP stdio server |
| `playwright` / `@playwright/browser-chromium` | 1.62.0 | chromium 1234（1.64.1 所需 1248 在可用镜像缺失，故下调） |
| `zod` | 3.25.76 | 工具 input schema |
| `typescript` | 5.9.2 | 构建 |

```bash
# 网络受限环境（本仓库开发环境实测）：
npm config 不动，安装时指定镜像并绕过失效代理：
env -u http_proxy -u https_proxy npm_config_registry=https://registry.npmmirror.com npm install

# 浏览器安装（@playwright/browser-chromium 的 postinstall 会自动装；
# 若带 --ignore-scripts 安装则手动执行）：
PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright npx playwright install chromium
```

## 构建 bundle（ocsjs fork 侧）

```bash
cd ../ocsjs
node scripts/build-mcp.js          # 产出 packages/scripts/dist-mcp/bundle.iife.js
cd ../server
node scripts/sync-bundle.mjs       # 同步到 server/dist-bundle/bundle.iife.js
```

## 构建 server

```bash
npm run build        # tsc → dist/
npm test             # node --test tests/*.test.mjs（答案编码四类 + run-manager 状态机）
```

## 账号配置

`config/account.json`（gitignore）：

```json
{ "username": "手机号/学号", "password": "..." }
```

`open_login` 自动尝试账号密码；验证码/风控一律转人工（返回截图），不做任何绕过。
登录态由持久 profile（`.browser-profile/`）承载。

## 运行（stdio）

```bash
node dist/index.js
```

MCP 客户端配置示例（如 ZCode / Claude）：

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

业务日志走 stderr，stdout 保留给 MCP 协议。

## 工具面（11 个）

`open_login` / `get_login_status` / `open_page` / `start_work` / `wait_next_work` /
`get_status` / `get_pending_questions` / `submit_answer` / `submit_answers` /
`submit_paper` / `abort_run` —— 语义与验收矩阵见开发文档 §4 / §8。

典型流程：

1. `open_login`（人工完成验证码）→ `open_page(课程学习页)` 得到 `session_id`；
2. `wait_next_work` 循环：`work-ready` → `get_status` + `get_pending_questions` →
   `submit_answers` → `get_status` 审核直到 `ready_for_review`；
3. 章节测验：`submit_paper('temporary')` 自动暂存后遍历继续（saved-and-left）；
   答案质量稳定后可 `submit_paper('confirm')`；
4. 作业页（手动）：`open_page(作业URL)` → `start_work` → 同一答题轮 →
   `submit_paper` 返回结构化 `unsupported`（v1 无自动暂存路径）→ 人工保存后
   `abort_run(reason:'manual-saved')`（终态 released）。

## 目录

```
src/index.ts        stdio 入口，注册 11 工具
src/browser.ts      Playwright 宿主（持久 profile / bypassCSP / bundle 注入 / __mcpEvent 绑定）
src/inject.ts       事件协议层（上行分发 / 下行指令 / 跨源存储中继）
src/run-manager.ts  权威 run 状态机 + 事件信封/游标 + 单 run 互斥 + 重进计数
src/adapters.ts     保存/提交适配协议（F10 server 侧）
src/login.ts        账号密码登录 + 验证码转人工
src/tools.ts        MCP 工具层（zod schema）
src/answer-encoding.ts  答案编码（填空 JSON 编码 / 分隔符校验，ADR-0021 §2）
dist-bundle/        fork 构建产物（sync-bundle 同步）
tests/              单元测试（answer-encoding / run-manager）+ 注入冒烟（smoke-inject.mjs）
```
