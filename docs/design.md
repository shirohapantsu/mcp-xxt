# mcp-xxt 系统总体设计文档

> **文档说明**：本文档汇总并提炼自 `docs/` 目录下的全部设计资产，包括 [开发文档.md](开发文档.md)（v1.2 实施基准）、[21 项架构决策记录（ADR-0001 ~ ADR-0021）](adr/README.md)、[领域术语表（glossary.md）](glossary.md)、四轮外部可行性评审（[v1](feasibility-review.md) / [v2](feasibility-review-v2.md) / [v3](feasibility-review-v3.md) / [v4](feasibility-review-v4.md)）以及三份真实站点端到端验收报告（[章节测验](test-reports/2026-10-24-chapter-e2e.md) / [作业页](test-reports/2026-10-24-homework-e2e.md) / [整课遍历](test-reports/2026-10-24-full-traversal.md)），全面说明项目的整体结构、核心机制与已实现功能。

---

## 目录

1. [项目背景与设计目标](#1-项目背景与设计目标)
2. [整体架构与项目结构](#2-整体架构与项目结构)
3. [核心实现功能与机制详解](#3-核心实现功能与机制详解)
   - [3.1 浏览器宿主、注入管线与登录接管](#31-浏览器宿主注入管线与登录接管)
   - [3.2 GM Shim 兼容层与跨源存储中继](#32-gm-shim-兼容层与跨源存储中继)
   - [3.3 跨 Frame 双向通信与事件游标协议](#33-跨-frame-双向通信与事件游标协议)
   - [3.4 双入口控制流与课程遍历导航](#34-双入口控制流与课程遍历导航)
   - [3.5 拉取式答题协议、答案编码与图片题管线](#35-拉取式答题协议答案编码与图片题管线)
   - [3.6 Worker 调度层改造与可取消传播](#36-worker-调度层改造与可取消传播)
   - [3.7 权威 Run 状态机与平台保存/提交适配](#37-权威-run-状态机与平台保存提交适配)
   - [3.8 媒体刷课硬禁用与悬浮面板裁剪](#38-媒体刷课硬禁用与悬浮面板裁剪)
4. [MCP 工具面全景规格（11 个工具）](#4-mcp-工具面全景规格11-个工具)
5. [架构决策（ADR）与四轮评审演进脉络](#5-架构决策adr与四轮评审演进脉络)
6. [测试体系与真实验收状态](#6-测试体系与真实验收状态)
7. [核心领域术语速查](#7-核心领域术语速查)

---

## 1. 项目背景与设计目标

`mcp-xxt` 将上游开源网课辅助脚本项目 `ocsjs`（v5.2.3，以 vendor fork 形式维护于 `ocsjs/`）改造为由 **MCP（Model Context Protocol）Server** 驱动的超星学习通（Chaoxing）**流程化答题系统**。

### 核心设计原则

1. **拉取式 AI 答题替代传统题库（ADR-0004）**：
   保留 `ocsjs` 成熟的 DOM 题目抓取、密文字体解密、四题型纯函数匹配器（`resolvers`）与页面填答处理器（`handler`），废除原有的远程题库配置与本地搜题缓存，替换为 **MCP 拉取式双工具协议**（`get_pending_questions` 取题 → Agent 推理作答 → `submit_answer` / `submit_answers` 回填）。
2. **学习媒体硬禁用，保留自动跳转骨架（ADR-0009 / ADR-0014 / ADR-0015）**：
   视频播放、倍速、音频、PPT、阅读时长等“刷课”功能在代码守卫级别**硬禁用**（源码保留不删除，确保与上游 git rebase 零冲突）；同时完整保留超星课程页的自动跳转框架（`searchJob` / `getNext` / `mode='next'`），作为自动寻路至各章节测验的导航骨架。
3. **严格的人机安全边界（ADR-0005 / ADR-0006 / ADR-0012）**：
   - **永不自动交卷**：废弃按完成率阈值自动交卷的逻辑，交卷必须通过显式工具 `submit_paper(mode)` 控制，默认采用安全态 `temporary`（暂存），仅在用户明确授权且经 `get_status` 逐题审核后才允许执行 `confirm`（交卷）。
   - **验证码与风控转人工**：内置有头 Chromium 浏览器与持久化 Profile，遇到滑块验证码、点选验证或平台风控一律截屏并转交人工在浏览器窗口完成，绝不内置打码或风控绕过逻辑。
   - **保留人类监督窗口**：保留裁剪后的 `easy-us` 页面悬浮面板，实时展示答题状态与日志供用户监督。
4. **范围聚焦（ADR-0003 / D14）**：
   聚焦超星学习通（`cx`）平台，支持**课程章节测验遍历**与**独立作业/随堂练习手动答题**两大核心工作流；支持单选（`single`）、多选（`multiple`）、判断（`judgement`）、填空（`completion`）四类题型自动回填，连线/完形/阅读（`line`/`fill`/`reader`）诚实标记为 `unsupported` 并安全跳过。

---

## 2. 整体架构与项目结构

### 2.1 系统三层架构图

```
┌─ 编排层：Agent + skills/mcp-xxt ──────────────────────────────────────────┐
│  • 课程遍历模式（主）：open_login → open_page(课程页)                      │
│      → wait_next_work ↻（取题 → 推理 → 回填 → get_status 审核 → 暂存/交卷）│
│      → course-finished / traversal-blocked / page-invalid 终止            │
│  • 手动作业模式：open_page(作业页) → start_work → 同一答题闭环 → released │
└───────────────────────────────┬───────────────────────────────────────────┘
                                │ MCP over stdio (@modelcontextprotocol/sdk)
                                │ (stdout 专用于协议通信，业务日志走 stderr)
┌───────────────────────────────▼───────────────────────────────────────────┐
│  宿主与权威控制层：server/（独立 TypeScript 项目）                        │
│  ├─ tools.ts          11 个 MCP 工具注册、Zod 校验、图片下载封装           │
│  ├─ run-manager.ts    权威 Run 状态机、300s 单一计时源、事件信封与游标、   │
│  │                    单活跃 Run 互斥、按 Job 身份的重进计数器             │
│  ├─ inject.ts         双向事件路由器（上行 __mcpEvent / 下行 evaluate）、  │
│  │                    跨源 GM 存储镜像与实时中继                           │
│  ├─ adapters.ts       平台保存/提交协议封装、超时 readResult 状态核验      │
│  ├─ answer-encoding.ts 填空 JSON 数组无损编码、分隔符与空位数预校验        │
│  ├─ login.ts          持久 Profile Cookie 检测、账号密码填充、验证码转人工 │
│  └─ browser.ts        Playwright 有头 Chromium、bypassCSP、addInitScript   │
└───────────────────────────────┬───────────────────────────────────────────┘
                                │ 导航注入 bundle.iife.js + exposeBinding
┌───────────────────────────────▼───────────────────────────────────────────┐
│  页面执行层：ocsjs/（vendor fork，entry-mcp 模式，页面主世界运行）        │
│  ├─ mcp/bootstrap.ts  幂等守卫 → MCP 模式标记 → GM shim → Frame 桥 → 启动 │
│  ├─ mcp/gm-shim.ts    localStorage 存储 + 三层变更通知（本帧/同源/跨源）   │
│  ├─ mcp/bridge.ts     Frame 本地桥 __OCS_MCP_BRIDGE__、待答队列、代次管理  │
│  ├─ mcp/answerer.ts   createMCPAnswerer、[图片N] 占位、应用结果事件发射    │
│  ├─ mcp/traversal.ts  work-detected 确认制、$.ajax 保存响应捕获、结果探测  │
│  ├─ mcp/panel-trim.ts 隐藏题库/搜题/更新/同步/媒体面板，保留监督窗         │
│  ├─ projects/cx.ts    超星脚本接线（F4）、媒体硬禁用（F5）、双模式适配     │
│  └─ @ocsjs/core       OCSWorker 调度改造与取消传播（F11）、四题型匹配器    │
└───────────────────────────────────────────────────────────────────────────┘
```

### 2.2 仓库目录结构

| 路径 | 模块定位 | 核心内容与职责 |
|---|---|---|
| `server/` | MCP Server 主工程 | 独立的 Node.js + TypeScript 项目，承载 Playwright 宿主、权威状态机与 11 个 MCP 工具 |
| `server/src/index.ts` | 进程入口 | 启动 `McpServer`（stdio 传输）、挂载后台 2s 周期的 `sweepDeadlines` 定时器與优雅退出清理 |
| `server/src/browser.ts` | 浏览器宿主 | 管理 Chromium 持久化上下文（`.browser-profile/`）、开启 `bypassCSP`、注册 `__mcpEvent` 绑定、注入 IIFE Bundle、提供共享 Cookie 的 `requestBinary` 下载器 |
| `server/src/inject.ts` | 事件与下行路由 | 分发页面上行事件（`hello`/`storage`/`work-detected`/`question`/`question-result`/`work-completed`/`submit-result` 等），封装向指定 Frame 下发指令与跨源存储中继 |
| `server/src/run-manager.ts` | 权威状态管理器 | 维护 `TraversalSession`（事件历史、游标、`request_id` 缓存）与 `ManagedRun`（状态机迁移、单 Run 互斥、300s 权威超时、身份化重进计数） |
| `server/src/adapters.ts` | 保存与提交适配层 | 协调 `submit_paper` 与 `abort_run`，在提交前动态复查页面能力，处理提交超时后的 `readResult` 二次核验 |
| `server/src/answer-encoding.ts` | 答案编码器 | 实现填空题 `JSON.stringify` 数组编码、单空分隔符校验、多选字母/全文编码，保障 `@ocsjs/core` 解析器无损还原 |
| `server/src/login.ts` | 登录控制器 | 读取 `config/account.json`，检测 Cookie / 个人中心登录态，自动填写手机号与密码，识别 Geetest/易盾验证码并截屏转人工 |
| `server/src/tools.ts` | MCP 工具定义 | 使用 Zod 定义并注册 11 个 MCP 工具，组装文本与顶层 `image` Content Block |
| `server/scripts/sync-bundle.mjs` | 构建同步脚本 | 将 `ocsjs` 侧构建产出的 `bundle.iife.js` 同步至 `server/dist-bundle/bundle.iife.js` |
| `server/tests/` | 自动化测试套件 | 包含答案编码与状态机单元测试、双 Origin 注入冒烟测试、MCP stdio 协议测试及真实站点验收脚本 |
| `ocsjs/` | 页面端脚本工程 | 基于 `ocsjs` v5.2.3 的 vendor fork（`mcp` 分支），实施 F1～F11 共 11 项受控改造点 |
| `ocsjs/packages/scripts/entry-mcp.js` | IIFE 打包入口 | 严格按 `bootstrap` → 样式与全局预置 → `trimPanelsForMCP()` → `start(definedProjects())` 顺序启动 |
| `ocsjs/packages/scripts/src/mcp/` | 页面侧 MCP 核心 | 包含 `bootstrap.ts`、`mode.ts`、`gm-shim.ts`、`bridge.ts`、`answerer.ts`、`traversal.ts`、`panel-trim.ts` |
| `ocsjs/packages/scripts/src/projects/cx.ts` | 超星平台实现 | 接入 `createMCPAnswerer`、绕过题库门禁、植入全入口媒体硬禁用守卫、接入章节测验与作业提交闸门 |
| `ocsjs/packages/core/src/core/worker/` | 答题引擎核心 | `worker.ts` 与 `question.resolver.ts` 实施 F11 改造（单一权威 Deadline、写前复查、取消 `signal` 穿透） |
| `skills/mcp-xxt/` | 配套 Agent Skill | 客户端编排规范（`SKILL.md`）、接口依赖声明（`agents/openai.yaml`）、连接构建指南（`references/connection.md`）与工具异常参考（`references/protocol.md`） |
| `docs/` | 设计与验收文档 | 开发基准文档、21 篇 ADR、术语表、4 轮可行性评审报告、3 份真实站点 E2E 测试报告 |

---

## 3. 核心实现功能与机制详解

本项目围绕 `ocsjs` 的 11 项改造点（**F1～F11**）与 `server` 的 20 项设计决议（**D1～D20**）构建了完整的答题闭环。

### 3.1 浏览器宿主、注入管线与登录接管

- **有头持久化浏览器（ADR-0001 / ADR-0008）**：
  `BrowserHost` 使用 `chromium.launchPersistentContext` 启动有头浏览器，Profile 持久化在 `server/.browser-profile/`，天然跨会话保留超星登录 Cookie。同时显式开启 `bypassCSP: true`（ADR-0019 §4），确保注入脚本与样式不受页面 Content-Security-Policy 阻断。
- **单文件 IIFE 构建与确定性 Bootstrap（F8 / ADR-0019）**：
  `ocsjs/scripts/build-mcp.js` 调用 `vite.config.mcp.ts` 将 `@ocsjs/core`、`@ocsjs/scripts`、CSS 样式及 MCP 适配层打包为单一自包含的 `bundle.iife.js`（全局变量 `OCS_MCP`），由 `context.addInitScript` 在每次文档导航及所有子 Frame 中自动注入。
  由于多个 `initScript` 顺序不可控，所有初始化逻辑收敛在 `bootstrap.ts` 单一入口中按序执行：
  1. 设置 `__OCS_MCP_BOOTSTRAPPED__` 幂等锁，防止同一文档重复初始化；
  2. 调用 `markMCPMode()` 冻结不可变的 MCP 模式标记（先于任何框架生命周期）；
  3. 调用 `installGMShim()` 安装油猴兼容层；
  4. 调用 `installBridge()` 注册当前 Frame 的 `__OCS_MCP_BRIDGE__`（分配唯一 Document 代次 UUID `gen`）；
  5. 捕获原生 `window.fetch` 为 `__OCS_NATIVE_FETCH__`（防止学习通页面反爬监控 SDK 包装 `fetch` 后对 `AbortSignal` 抛出 `Illegal invocation`，保障字体解密字库下载正常）；
  6. 注册 `readystatechange` 锚点保底（解决 `document-start` 注入时 `document.body` 为空导致 `easy-us` 悬浮面板 `CustomWindow.mount` 抛错且永不重试的问题）；
  7. 发送上行 `hello` 事件，通知 Server 记录 Frame 代次并下发跨源存储快照。
- **双通登录与验证码人工接管（ADR-0008 / ADR-0012）**：
  `get_login_status` 优先检查 `www.chaoxing.com` 下的 `UID` / `_uid` Cookie，缺失时打开 `i.chaoxing.com` 核验 DOM。`open_login` 自动读取 `server/config/account.json`（或兼容根目录 `passwd.json`）填入手机号与密码；若页面出现 `.geetest_box`、`.yidun_panel` 等验证码组件或登录失败，立即截取当前页面 PNG 作为 `image` Content Block 返回 `{ status: 'need-human' }`，由用户在有头浏览器窗口手动完成后继续。

### 3.2 GM Shim 兼容层与跨源存储中继

`easy-us` 框架（v1.0.15）的跨 Frame 通信（`cors.emit` / `defineTopFunction`）与悬浮面板状态同步完全构建在 `GM_setValue` + `GM_addValueChangeListener` 之上，且**内部没有任何超时机制**——若监听器为 no-op 或跨源丢失通知，页面脚本将静默永久挂起（ADR-0020 §1 / ADR-0021 §1）。为此，`gm-shim.ts` 与 `inject.ts` 实现了完整的三层存储与通知架构（**F1**）：

1. **存储与单 Tab 会话后端**：
   - `GM_setValue` / `GM_getValue` / `GM_deleteValue` / `GM_listValues` 以 `__ocs_gm__:` 前缀读写当前 Origin 的 `localStorage`，同时维护内存镜像 `state.mirror` 作为跨源或隐私模式兜底。
   - `GM_getTab` / `GM_saveTab` 以 `__ocs_gm_tab__:tab` 读写 `localStorage`，支撑超星脚本的章节计数（`$store.getTab('chapter_counter')`）与 `easy-us` 的 `TAB_UID` 识别。
2. **三层变更通知分发**：
   - **第一层（本 Frame 内）**：写入时立即同步调用本 Frame 注册的 `GM_addValueChangeListener` 回调（`remote = false`）。
   - **第二层（同源 Frame 间）**：通过 `BroadcastChannel('__ocs_gm_broadcast__')` 向同一 Origin 的其他 Frame 广播，接收端更新 `mirror` 并触发回调（`remote = true`）。
   - **第三层（跨源 Frame 间，如 `mooc1.chaoxing.com` ↔ `mobilelearn.chaoxing.com`）**：写入时经 `window.__mcpEvent('storage', { key, value, gen })` 上报 Server；Server 更新 `RunManager.storageMirror`，并遍历所有非同源 Frame 下发 `relay-storage` 指令，调用接收端 `window.__OCS_GM_RELAY__(key, value)` **先写入本地内存镜像 `mirror`，再以 `remote = true` 触发监听器**，从而保证接收端在回调中调用 `GM_getValue` 必定能读到最新值。此外，新 Frame 启动发送 `hello` 时，Server 自动下发 `storage-snapshot` 同步全量初始键值。
3. **跨域请求隔离**：
   `GM_xmlhttpRequest` 提供立即触发 `onerror` 的错误桩以防调用方挂起；所有需要跨域或携带登录态的二进制请求（如题图下载）统一交由 Server 端 `context.request` 执行。

### 3.3 跨 Frame 双向通信与事件游标协议

超星课程页包含多层嵌套 iframe（如顶层 `studentstudy` → `iframe` 知识卡片层 → `doHomeWorkNew` 测验帧），且学校壳域名下可能存在跨域 iframe。因此系统不依赖 `window.top` 共享状态，而是采用 **Server 权威状态 + 全 Frame 独立桥** 架构（**F2 / ADR-0017 / ADR-0020 / ADR-0021**）：

- **上行通道（Frame → Server）**：Playwright `context.exposeBinding('__mcpEvent')` 在所有 Frame 注入全局绑定函数。Server 从回调首个参数 `source` 直接获取真实的 `page` 与 `frame` 引用，结合负载中的 `gen`（Document 代次）追踪 Frame 生命周期。一旦同一 URL 的 Frame 上报了新的 `gen`（发生重载或导航），Server 自动将绑定旧 `gen` 的未终态 Run 迁移至 `aborted`。
- **下行通道（Server → Frame）**：`EventRouter` 保存 `runId → { frame, url, gen }` 映射，通过 `frame.evaluate` 调用目标 Frame 的 `window.__OCS_MCP_BRIDGE__._onDownlink(msg)`，下发 `bind-run`、`start-manual`、`deadline`、`answer`、`cancel`、`submit`、`read-result` 等指令。
- **事件信封与 Per-Session 游标投递**：
  - 每次 `open_page` 命中课程学习页（`/mycourse/studentstudy`）时，Server 创建新的 `TraversalSession` 并返回 `session_id`（同时自动终止该页面上的旧 Session 及其挂起的等待者）。
  - 所有事件封装为 `Envelope`（含单调递增的 `eventId`、`sessionId`、可选 `runId`、`type`、`payload`、`frame`）。
  - `wait_next_work` 仅消费四类可投递事件：`work-detected`（转换为 `work-ready`）、`course-finished`、`traversal-blocked`、`page-invalid`。Server 按 `session.cursor` 保证**每个事件至多投递一次**；若事件早于 `wait_next_work` 发生，调用时先扫描历史立即返回，绝不丢失早期事件；若等待超时（默认 60s），返回 `{ event: 'still-waiting' }` 且不推进游标。
  - **幂等重试与自愈兜底**：`wait_next_work` 支持传入 `request_id`，当客户端因网络或自身超时重发相同 `request_id` 时，Server 直接返回 `requestIdCache` 中已投递的响应，防止跳过当前 `work-ready`；即便客户端未传 `request_id` 导致事件丢失，Agent 也可调用不带参数的 `get_status({})` 重新发现当前未终态的活跃 Run。

### 3.4 双入口控制流与课程遍历导航

系统支持两种互补的答题入口（**F4 / F9 / ADR-0015 / ADR-0020**）：

1. **课程遍历模式（脚本驱动，自动建 Run）**：
   - 在超星 `study` 脚本中，MCP 模式下强制将跳转模式预设为 `mode = 'next'`（顺序推进下一小节，避免因媒体任务点被禁用未完成而卡在 `job` 模式），并绕过 `searchJob`（`cx.ts:1712`）、`chapter()` 入口（`cx.ts:1959`）与章节自建 `answerer`（`cx.ts:2032`）三处题库配置门禁。
   - 当 `JobRunner` 遇到章节测验进入 `chapterWithMCP()` 时，首先发送 `work-detected` 事件并 `await` Server 回执（**确认制**）。Server 校验无活跃 Run 冲突且重进计数未超限后，创建 `mode: 'course'` 的 `ManagedRun`，唤醒 Agent 的 `wait_next_work` 返回 `{ event: 'work-ready', run_id, session_id }`，并向页面回执 `{ ok: true, run_id }`，页面这才启动 `OCSWorker` 注册题目。
   - **身份化重进计数**：Server 按 `courseId|clazzId|chapterId|jobId` 统计同一测验连续进入次数。同一章节下的多个不同测验因 `jobId` 不同互不累计；一旦任一测验成功暂存（`saved-and-left`）或交卷（`finished`），立即重置该身份的计数器；若同一测验连续第 3 次进入仍未取得进展，Server 判定闯关受阻，拒绝建 Run 并向 Session 发射 `traversal-blocked`。
   - **遍历终止出口分类**：当全部章节推进完毕时上报 `course-finished`；当遇到章节锁定（`cx.ts:1481`）、无法跳转下一章或最后一个章节仍有未完成任务点（`cx.ts:1567`）时上报 `traversal-blocked`（附具体原因）；当页面异常重定向时上报 `page-invalid`。
2. **独立作业/练习模式（Agent 驱动，手动建 Run）**：
   - 针对独立作业页（`/mooc2/work/dowork`）、整卷预览（`/mooc2/exam/preview`）与随堂练习（`/page/quiz/stu/answerQuestion2`），在 `commonWork` 中抑制了原有的 `oncomplete` 5 秒倒计时自动启动，改为向 Frame 桥注册 `registerManualWork` 外部启动器与惰性能力探测函数 `mcpRegisterSubmitCapabilities`。
   - Agent 导航至页面后显式调用 `start_work`，Server 轮询探测页面的真实代次 `gen` 与保存/提交能力（`capabilities`），创建 `mode: 'manual'` 的 `ManagedRun`，随后下发 `bind-run` 与 `start-manual` 指令触发页面开始抓题。

### 3.5 拉取式答题协议、答案编码与图片题管线

- **MCP Answerer 契约复用（F3 / ADR-0004）**：
  `createMCPAnswerer`（`ocsjs/packages/scripts/src/mcp/answerer.ts`）实现了与原 `createCommonAnswerer` 完全一致的函数签名，返回 `Promise<SearchInformation[]>`（`name: 'mcp-agent'`）。
  - 对于每道题目，先通过 `typeTransform` 从页面隐藏表单提取题型写入 `ctx.type`。
  - 若题型不在 `['single', 'multiple', 'judgement', 'completion']` 中（如连线、完形、阅读），调用 `bridge.registerUnsupportedQuestion` 直接注册为 `unsupported` 终态并返回空结果，不触碰页面 DOM。
  - 若题型受支持，调用 `bridge.enqueueQuestion` 将题目（`id`、`type`、`title`、`options`、`images`、`blankCount`）上报 Server 并挂起 Promise 等待回填。
- **确定性答案编码（D15 / D19 / D20 / ADR-0021 §2）**：
  `@ocsjs/core` 的 `SearchInformation.answer` 类型为 `string`，且 `splitAnswer` 支持优先按 `JSON.parse` 解析 JSON 数组字符串，其次按分隔符（`===`、`#`、`---`、`###`、`|`、`;`、`；`）拆分。`server/src/answer-encoding.ts` 在工具层执行严格预校验与无损编码：
  - **单选题（`single`）**：接受选项字母（如 `"B"`）或完整选项文本。
  - **多选题（`multiple`）**：接受字母串（`"AC"`）、单字母数组（`["A", "C"]` → 编码为 `"AC"`，走 `resolveMultiple` 纯字母兜底）或选项全文数组（`["选项一", "选项三"]` → `JSON.stringify` 编码，走 `splitAnswer` JSON 分支逐项匹配）。
  - **判断题（`judgement`）**：接受 `"正确"` / `"错误"` / `"对"` / `"错"` / `"√"` / `"×"` / `"T"` / `"F"`。
  - **填空题（`completion`）**：推荐传入 `string[]`（每空一项），Server 使用 `JSON.stringify` 无损编码（彻底解决单空答案如 `["C#"]`、多空含分隔符如 `["a===b", "c"]` 在旧式 join 方案下被错拆的问题）。若传入纯 `string` 且为单空（`blankCount === 1`）但包含分隔符，Server 明确拒绝并提示改用 `string[]`；若分拆项数与 `blankCount` 不一致或存在空字符串项，同样返回结构化错误。
  - **显式跳过（`null`）**：传入 `null` 表示跳过该题，题目状态置为 `skipped`，Answerer 返回空结果，不执行任何 DOM 写入。
- **多模态图片题管线（ADR-0010 / ADR-0019 §3）**：
  1. 页面抓题时，`extractTextWithImages` 将 `<img>` 标签还原为图片 URL，`placeholderImages` 按首次出现顺序将题干和选项中的图片 URL 替换为 `[图片1]`、`[图片2]` 占位符，并将去重后的 URL 列表存入 `question.images`。
  2. Agent 调用 `get_pending_questions` 时，Server 使用 `browser.requestBinary(url, frameUrl)`（通过 Playwright `context.request` 共享浏览器登录 Cookie 及 Referer）下载图片字节流，校验大小不超过 4 MiB 后，封装为 MCP 顶层 `image` Content Block（附真实 MIME 类型）返回给大模型视觉管线。
  3. 同时修复了上游 `ocsjs/packages/scripts/src/utils/answerer-env.ts` 中 `normalizeToPngDataUrl` 仅替换文本前缀而不转换图片字节、导致 JPEG/GIF 被错标为 `image/png` 的历史缺陷（通过 Canvas 重绘输出真实 PNG，失败时保留原始 MIME）。

### 3.6 Worker 调度层改造与可取消传播

上游 `@ocsjs/core` 的 `OCSWorker` 存在两处与 MCP 协议冲突的硬伤：① 答题线程 `waitForRequested` 硬编码 `(timeout_seconds + 10) * 1000 = 70s` 超时，导致 MCP 规定的 300s 慢思考回填在第 70s 后被丢弃；② 等待结束后不复查 `isClose` 状态，且多选逐项点击循环间无取消检查，导致 `abort_run` 后迟到的回调仍会继续污染页面 DOM（ADR-0016 / ADR-0020 §5）。

为此，**F11** 在 `packages/core/src/core/worker/worker.ts`、`question.resolver.ts` 与 `cx.ts` 实施了精细改造：

1. **单一权威 Deadline（300s）**：`WorkOptions` 新增 `requestTimeoutMs?: number | false`。MCP 模式下传入 `false`，禁用 Worker 内部的 70s 派生超时；每题超时完全由 Server 在题目入队时计算的 300s 权威 `deadline`（下发至 Frame 桥定时器，并由 Server `sweepDeadlines` 兜底）统一裁决。
2. **全链路取消 Signal 穿透**：
   - `WorkContext` 新增 `isCancelled?: () => boolean` 钩子，绑定 `() => this.isClose || Boolean(this.opts.isCancelled?.())`。
   - 在 `worker.ts` 中，`await waitForRequested` 返回后、调用 `work` handler 写入 DOM 前，强制复查 `isClose` 与 `ctx.isCancelled()`；若已取消则立即跳过 DOM 写入。
   - 在 `question.resolver.ts` 中，`single`、`multiple`（逐项勾选循环的每一步前）、`judgement`、`completion`（逐空填写循环的每一步前）均检查 `ctx?.isCancelled?.()`，一旦取消立即中断后续操作并返回 `{ finish: false }`。
   - 在 `cx.ts` 的自定义题目 handler 中，每次点击选项或填写输入框并 `await $.sleep(500)` 前后均检查取消状态。
3. **DOM 根节点观察器兜底**：超星各场景的 `OCSWorker` 均启用 `rootObserver: true`，当题目容器从 DOM 移除时自动触发 Worker 关闭。

### 3.7 权威 Run 状态机与平台保存/提交适配

#### Run 状态迁移图（D13 / D19 / ADR-0017 / ADR-0020）

```
running
  │ (全部题目到达终态 applied/applied-failed/timeout/skipped/unsupported
  │  且收到匹配当前 frameGen 的 work-completed 事件)
  ▼
ready_for_review ──────────────────────────────────────┐
  │                                                    │
  ├─ submit_paper('temporary') ──▶ saving              │
  │     ├─ 失败 ──▶ 退回 ready_for_review（保留重试）  │
  │     └─ 成功 ──┬─ [课程模式] ──▶ saved-and-left (终态，释放互斥，继续遍历)
  │               └─ [手动模式] ──▶ saved (非终态，页面仍占用)
  │                                   ├── abort_run('manual-saved') ──▶ released (终态)
  │                                   └── submit_paper('confirm') ────┐
  │                                                                   ▼
  └─ submit_paper('confirm') ──────────────────────────────────▶ submitting
                                                                   ├─ 成功 ──▶ finished (终态)
                                                                   ├─ 失败 ──▶ 退回 ready_for_review
                                                                   └─ 超时不确定 ──▶ readResult 核验
                                                                        ├─ 核验已交 ──▶ finished (终态)
                                                                        └─ 仍不确定 ──▶ ready_for_review (置 submit_uncertain=true，禁止盲目重交)

* 任意非终态下调用 abort_run(reason) ──▶ released (当 reason==='manual-saved') 或 aborted (其他原因，终态)
* Frame 重生(代次变化) / 页面关闭 ──▶ aborted (终态)
```

#### 平台保存与提交适配器（F6 / F10 / ADR-0018）

| 页面场景 | 入口模式 | `auto_save` (`temporary`) | `auto_submit` (`confirm`) | 页面侧执行与确认机制 |
|---|---|---|---|---|
| **章节测验** (`doHomeWorkNew` 帧) | 课程遍历 (`wait_next_work`) | `true` | `true` | `temporary` 调用 `noSubmit()`（底层 `saveWork()` 带 `tempsave=1`）；`confirm` 调用 `btnBlueSubmit()` + `submitCheckTimes()`。包装帧内 `$.ajax` 捕获 `/work/addStudentWorkNew` 响应 JSON 的 `data.status` 为权威成功证据（排除 `/work/validate`），`$.toast` / `alert` 为辅助证据。提交闸门采用 `while` 循环，保存失败时停留在当前测验等待重试指令，成功或取消后才释放遍历继续跳转。 |
| **独立作业页** (`/mooc2/work/dowork`) | 手动启动 (`start_work`) | `true` (动态探测 `saveWork`) | `false` | 页面加载时注册惰性能力探测 `typeof window.saveWork === 'function'`。`temporary` 调用 `saveWork()` 并捕获 `$.ajax` 响应 JSON `status=true` 确认暂存成功，状态进入 `saved`；收尾时调用 `abort_run(reason: 'manual-saved')` 进入 `released` 终态。`confirm` 因 `auto_submit=false` 在 Server 侧安全拦截并返回结构化 `unsupported`。 |
| **整卷预览 / 随堂练习** | 手动启动 (`start_work`) | 动态探测（默认 `false`） | `false` | 完成填答进入 `ready_for_review`；若页面无自动保存函数，`submit_paper` 诚实返回 `unsupported`，提示用户人工保存后调用 `abort_run(reason: 'manual-saved')` 释放 Run。 |

### 3.8 媒体刷课硬禁用与悬浮面板裁剪

- **全入口媒体守卫（F5 / ADR-0014 / ADR-0019 §1）**：
  基于 `isMCPMode()` 不可变标记（而非桥对象存在性，也不是可被用户修改的面板配置），在超星脚本的所有学习媒体入口植入硬短路守卫：
  1. `study.onactive` 的 `/readsvr/book/mooc` 独立阅读分支（不经过 `JobRunner`）；
  2. `JobRunner` 内的 `media`（音视频）、`read`（阅读）、`timereader`（计时阅读）、`pptWithAudio`（有声 PPT）、`hyperlink`（外链任务点）五个分支；
  3. `autoRead` 脚本（`oncomplete` 生命周期）；
  4. `rateHack` 倍速脚本（`onstart` 生命周期）。
  触发守卫时统一调用 `mcpLogMediaSkipped(jobName, entry)` 向 Server 输出 `media-skip` 日志，随后正常进入 `getNext` 推进下一章节。
- **悬浮面板裁剪（F7 / ADR-0006）**：
  `trimPanelsForMCP()` 在启动前将 `CommonProject.scripts.settings`（题库配置）、`CommonProject.scripts.onlineSearch`（在线搜题）、`BackgroundProject.scripts.update`（上游更新）、`BackgroundProject.scripts.appConfigSync`（桌面端同步）、`BackgroundProject.scripts.menus`（油猴菜单）、`CXProject.scripts.study` 与 `CXProject.scripts.autoRead` 标记为 `hideInPanel = true`，仅保留答题结果展示（`workResults`）、日志控制台（`console`）与弹窗屏蔽等监督面板。

---

## 4. MCP 工具面全景规格（11 个工具）

Server 通过 `@modelcontextprotocol/sdk` 在 stdio 上暴露 11 个工具（无课程/作业发现类工具，URL 由用户提供）：

| 工具名称 | 输入参数（Zod Schema） | 核心返回字段（`structuredContent`） | 功能说明与调用约束 |
|---|---|---|---|
| `open_login` | `{}` | `{ status: 'ok' \| 'need-human' \| 'failed', detail }`（必要时顶层附带截图 `image` block） | 打开超星登录页，自动尝试 `server/config/account.json` 账号密码；遇验证码或风控立即截屏返回 `need-human` 转人工处理。 |
| `get_login_status` | `{}` | `{ loggedIn: boolean, detail: string }` | 检查持久化 Profile 中的登录 Cookie（`UID`/`_uid`）或个人中心状态。 |
| `open_page` | `{ url: string }` | `{ url, title, session_id? }` | 通用页面导航。当 URL 匹配课程学习页（`/mycourse/studentstudy`）时创建新 `TraversalSession` 并返回 `session_id`（同时终止旧 Session）。 |
| `start_work` | `{}` | `{ run_id: string }` | **手动模式入口**（独立作业/考试预览/随堂练习页）。动态探测页面保存能力并创建手动 Run；课程遍历模式下严禁调用。 |
| `wait_next_work` | `{ timeout_s?: number, request_id?: string }` | `{ event: 'work-ready' \| 'still-waiting' \| 'course-finished' \| 'traversal-blocked' \| 'page-invalid', run_id?, session_id?, reason? }` | **课程遍历模式核心阻塞工具**。按 Session 游标投递事件；超时默认 60s 返回 `still-waiting`（不消耗事件）；客户端超时重试可传相同 `request_id` 获取缓存响应。 |
| `get_status` | `{ run_id?: string }` | `{ run_id, mode, status, capabilities, work_completed, question_count, questions: [...], submit_uncertain, submit_error }` | 查询指定或当前活跃 Run 的完整状态、动态能力标志与逐题应用结果（生成**逐题审核单**的唯一权威数据源；事件丢失时可缺省 `run_id` 重新发现活跃 Run）。 |
| `get_pending_questions` | `{ run_id: string }` | `{ questions: [{ id, type, title, options?, images?, blankCount? }] }`（题图位于工具结果顶层 `content` 的 `image` block） | 获取当前状态为 `pending` 的待答题目。题图由 Server 携带 Cookie 下载后置于顶层 `content`。注意：**`pending` 为空不代表整卷完成**，必须以 `get_status` 的 `ready_for_review` 为准。 |
| `submit_answer` | `{ run_id: string, question_id: string, answer: string \| string[] \| null }` | `{ question_id, status: 'answered' \| 'skipped' }` | 回填单道题答案。填空题推荐传 `string[]`（JSON 编码）；传 `null` 显式跳过该题；已非 `pending` 的题目重复回填会返回明确错误。 |
| `submit_answers` | `{ run_id: string, answers: Array<{ question_id, answer }> }` | `{ results: Array<{ question_id, ok: boolean, error? }> }` | 批量回填答案。逐题独立校验与下发，部分失败不影响其余题目。 |
| `submit_paper` | `{ run_id: string, mode: 'temporary' \| 'confirm' }` | `{ status: 'saved' \| 'saved-and-left' \| 'finished' \| 'failed' \| 'uncertain' \| 'unsupported', evidence?, message? }` | 提交或暂存试卷。仅在 `ready_for_review` 或手动 `saved` 状态下可用；`temporary` 为暂存（课程模式成功后进入 `saved-and-left` 终态并继续遍历，手动模式进入 `saved`）；`confirm` 为正式交卷。 |
| `abort_run` | `{ run_id: string, reason?: string }` | `{ run_id, status: 'aborted' \| 'released' }` | 终止当前 Run 并向页面广播取消 `signal` 停止一切等待与 DOM 写入。当 `reason === 'manual-saved'` 时终态记为 `released`，否则记为 `aborted`。 |

---

## 5. 架构决策（ADR）与四轮评审演进脉络

项目在设计阶段经历了三轮架构访谈（沉淀为 **ADR-0001 ~ ADR-0015**）和四轮严格的源码级可行性审查（沉淀为 **ADR-0016 ~ ADR-0021**，最终在 [第四次审查](feasibility-review-v4.md) 中全部闭合）：

| ADR 编号 | 决策主题 | 核心结论与演进说明 |
|---|---|---|
| [ADR-0001](adr/0001-playwright-injection.md) | 浏览器宿主 | MCP Server 内置 Playwright 有头 Chromium + 持久 Profile，以 `addInitScript` 注入改造后的单文件 Bundle，不依赖油猴扩展或 OCS 桌面端。 |
| [ADR-0002](adr/0002-project-layout.md) | 项目组织 | `ocsjs/` 作为 vendor fork 保留在仓库内（便于跟进上游修复），`server/` 作为独立 TypeScript 项目通过 stdio 暴露 MCP 服务。 |
| [ADR-0003](adr/0003-scope-cx-only.md) | 平台范围 | 仅聚焦超星学习通（`cx`），其余 5 个网课平台源码保留但不在 MCP 工具面暴露。 |
| [ADR-0004](adr/0004-pull-based-answer-protocol.md) | 答题交互协议 | 采用拉取式双工具（`get_pending_questions` + `submit_answers`），`createMCPAnswerer` 保持 `SearchInformation[]` 返回契约以复用核心题型匹配器。 |
| [ADR-0005](adr/0005-no-auto-submit.md) | 提交安全边界 | 废弃完成率阈值自动交卷，交卷由独立工具 `submit_paper(mode)` 显式触发，默认 `temporary` 暂存。 |
| [ADR-0006](adr/0006-keep-ui.md) | 保留悬浮面板 | 保留 `easy-us` 页面悬浮面板作为人类监督窗口，裁剪无关配置项。 |
| [ADR-0007](adr/0007-mcp-tool-surface.md) | MCP 工具面与超时 | 定义以 `run_id` 为句柄的生命周期工具面；单题等待 Agent 回填上限设为 300s，超时标记 `timeout` 继续流程。 |
| [ADR-0008](adr/0008-login.md) | 双通道登录态 | 持久 Profile Cookie 自动复用 + `server/config/account.json` 账号密码自动填充。 |
| [ADR-0009](adr/0009-disable-not-delete.md) | 禁用而非删除 | 刷课代码通过模式守卫禁用而不删除源码，保留自动跳转框架作为课程遍历导航骨架。 |
| [ADR-0010](adr/0010-image-questions.md) | 图片题协议 | 题干/选项图片转为 `[图片N]` 占位符，图片数据以 Base64 编码通过 MCP `image` Content Block 传递给 Agent。 |
| [ADR-0011](adr/0011-skill-superseded.md) | 技能定位重构 | 旧版独立自动化脚本退役，MCP Server 成为唯一自动化执行引擎，`skills/mcp-xxt` 作为纯客户端编排层说明。 |
| [ADR-0012](adr/0012-captcha-human-handoff.md) | 验证码人工接管 | 遇到登录或答题验证码/风控一律截屏返回 `need-human`，由人工在有头浏览器中完成，绝不打码绕过。 |
| [ADR-0013](adr/0013-single-run.md) | 单活跃 Run 互斥 | 同一时刻全局最多允许一个未终态 Run，消除多页面/多测验并发状态混乱。 |
| [ADR-0014](adr/0014-hard-disable-media.md) | 媒体硬禁用 | 在代码分支入口基于不可变 MCP 模式标记硬短路媒体任务，即便用户在面板手动勾选配置也绝不执行。 |
| [ADR-0015](adr/0015-script-driven-traversal.md) | 控制流反转 | 课程模式下由页面脚本按 `mode='next'` 驱动遍历，遇章节测验上报 `work-detected`，Agent 通过 `wait_next_work` 阻塞等待介入。 |
| [ADR-0016](adr/0016-worker-wait-cancel.md) | Worker 调度层改造（一审修订） | 解决 `worker.ts` 70s 硬编码超时吞掉 300s 回填、取消后仍写入 DOM 及 `cx` 缺少 `rootObserver` 三大问题（新增改造点 F11）。 |
| [ADR-0017](adr/0017-bridge-and-run-state.md) | 跨 Frame 桥与状态机（一审修订） | 废除不可靠的 `window.top` 跨域假设，改用 `exposeBinding('__mcpEvent')` + Server 权威状态机；引入 `work-detected` 确认制与遍历出口三分类。 |
| [ADR-0018](adr/0018-platform-save-submit-adapters.md) | 平台保存/提交适配器（一审修订） | 针对章节测验与作业/考试保存能力不对称问题，设计能力标志与适配器接口（新增改造点 F10），以真实请求响应确认提交结果。 |
| [ADR-0019](adr/0019-review-misc-amendments.md) | 评审杂项补全（一审修订） | 补全 `/readsvr/book/mooc` 与 `timereader` 媒体守卫、确立图片由 Server `context.request` 下载、修复 `normalizeToPngDataUrl` 字节缺陷、规定单一 IIFE Bootstrap 顺序。 |
| [ADR-0020](adr/0020-review-v2-amendments.md) | 二次评审修订 | 强制实现 `GM_addValueChangeListener` 防止 `easy-us` 静默挂起；增补 `saved-and-left` 与 `released` 终态；确立 `question-result` + `work-completed` 驱动 `ready_for_review`；引入事件游标、取消 Signal 穿透至 Handler 层、按 Job 身份重进计数及 `auto_save`/`auto_submit` 能力拆分。 |
| [ADR-0021](adr/0021-review-v3-amendments.md) | 三次评审修订 | 补全跨源 Frame 的 Server 存储镜像与通知中继（解决 `BroadcastChannel` 仅限同源的局限）；填空题改用 `JSON.stringify` 数组编码（解决 `["C#"]` 等分隔符误拆）；完善 `open_page` 的 `session_id` 生命周期与 `wait_next_work` 的 `request_id` 缓存重试边界。 |

---

## 6. 测试体系与真实验收状态

项目在 `server/tests/` 下构建了从纯函数单元、本地多源注入冒烟、MCP 协议层到真实超星站点端到端验收的四级验证体系：

| 测试层级 | 脚本路径 | 验证内容 | 当前状态 |
|---|---|---|---|
| **单元测试** | `server/tests/answer-encoding.test.mjs`<br>`server/tests/run-manager.test.mjs` | 覆盖填空 JSON 数组编码 6 类边界（双空、内部含 `===`、单空 `["C#"]`、多分隔符、引号反斜线、嵌套 JSON 文本）、多选编码、Run 状态机全路径迁移、Session 游标投递、`request_id` 缓存、单 Run 互斥、按 Job 身份重进计数与进展重置。 | ✅ 全部通过 |
| **双源注入冒烟** | `server/tests/smoke-inject.mjs` | 本地启动两个不同端口（跨 Origin）HTTP 服务，验证 `addInitScript` IIFE 注入、GM Shim 同源 `BroadcastChannel` 与跨源 Server 存储镜像中继、`work-detected` 确认制、题目入队、答案回填、DOM 写入及 `abort_run` 取消传播。 | ✅ 全部通过 |
| **MCP 协议层测试** | `server/tests/mcp-stdio-test.mjs` | 通过 `@modelcontextprotocol/sdk` 客户端连接 stdio Server，校验 11 个工具的 Schema 注册与基础错误处理。 | ✅ 全部通过 |
| **章节测验真实 E2E** | `server/tests/full-chain-chapter.mjs`<br>`server/tests/chapter-save-inspect.mjs` | 真实超星课程章节测验（20 题：单选 9、多选 7、判断 4）：自动登录 → 课程遍历命中测验 → 20/20 题回填 `applied`（`finish=true`）→ `ready_for_review` → `submit_paper('temporary')` → 捕获 `/work/addStudentWorkNew` 响应 `status=true` → 进入 `saved-and-left` 终态并继续遍历；独立无注入浏览器复核 20/20 题平台持久化一致（详见 [章节测验验收报告](test-reports/2026-10-24-chapter-e2e.md)）。 | ✅ 真实站点通过 |
| **整课遍历真实 E2E** | `server/tests/full-traversal.mjs` | 真实超星课程全章节遍历（跳过答题模式，17.8 分钟）：连续遍历 8 个章节的 8 个测验（共 160 题），79 个媒体任务点全部由 F5 守卫安全跳过，每个测验完整走完 `work-ready → 20 skipped → ready_for_review → temporary → saved-and-left`，重进计数 8 次正常重置，最终在末章以可诊断的 `traversal-blocked` 诚实终止，且先前已保存的真实答案未被覆盖破坏（详见 [整课遍历验收报告](test-reports/2026-10-24-full-traversal.md)）。 | ✅ 真实站点通过 |
| **作业页手动全链 E2E** | `server/tests/full-homework.mjs`<br>`server/tests/homework-save-inspect.mjs` | 真实超星独立作业页（15 题：单选 8、判断 7）：`open_page` → `start_work` 动态探测 `auto_save=true, auto_submit=false` 并同步真实 `frameGen` → 15/15 题真实作答 `applied` → `ready_for_review` → `submit_paper('temporary')` 调用 `saveWork()` 暂存成功进入 `saved` → `abort_run('manual-saved')` 进入 `released` 释放互斥；只读复核 15/15 题已暂存且未交卷（详见 [作业页验收报告](test-reports/2026-10-24-homework-e2e.md)）。 | ✅ 真实站点通过 |

> **已知遗留与后续回归项**：
> 1. 超星密文字体解密（`FontDecryptor` 位图特征匹配）在个别低置信度字形上存在近似字偏差（如“渭/清”、“邡/部”），已列为独立回归项；
> 2. 真实站点下 `mode='confirm'` 正式交卷链路（因会消耗真实账号作答机会，目前仅执行 `temporary` 暂存验收）、含图题真实验收及 >70s 慢回填的真实站点验证可在后续按需执行。

---

## 7. 核心领域术语速查

| 术语 | 定义与项目内语义 |
|---|---|
| **Project / Script** | `easy-us` 框架的两级组织单元：`Project` 对应平台（如 `CXProject`），`Script` 对应具体路由脚本（含 `onstart`/`onactive`/`oncomplete` 生命周期）。 |
| **OCSWorker / resolvers** | `@ocsjs/core` 的自动答题引擎与四题型纯函数匹配器（`single`/`multiple`/`judgement`/`completion`），通过归一化精确匹配、相似度匹配（阈值 0.6）与纯字母兜底完成选项定位。 |
| **SearchInformation** | 查题器返回结果契约 `{ results: [{ question, answer }], name, error }`。`createMCPAnswerer` 保持此结构以原样复用 `@ocsjs/core` 匹配管线。 |
| **TraversalSession (`session_id`)** | 一次课程学习页遍历会话，由 `open_page(课程学习页)` 创建，承载单调递增的 `eventId` 历史、消费游标 `cursor` 与 `request_id` 响应缓存。 |
| **ManagedRun (`run_id`)** | 一次章节测验或独立作业的权威答题实例，由 `work-detected` 事件（课程模式）或 `start_work` 工具（手动模式）创建，全局单活跃 Run 互斥。 |
| **`saved-and-left`** | 课程遍历模式下 `submit_paper('temporary')` 成功后的**终态**：表示答案已暂存且页面即将跳转至下一小节，释放单 Run 互斥，不可再对该 Run 调用 `confirm`。 |
| **`released`** | 手动作业模式下人工保存完成或暂存收尾时调用 `abort_run(reason: 'manual-saved')` 进入的**正常结束终态**，以区别于异常中止的 `aborted`。 |
| **事件信封与游标** | Server 为每个 Session 维护的事件队列与已投递位置指针，保证 `wait_next_work` 即使遭遇客户端超时重试也遵循“至多投递一次、早到事件不丢”的精确消费语义。 |
| **计数身份化 (`RunIdentity`)** | 以 `courseId\|clazzId\|chapterId\|jobId` 组成的唯一测验身份键，确保同一章节内多个不同测验顺序执行时不误触闯关防循环阈值。 |
| **三层通知 Shim** | `gm-shim.ts` 对 `GM_addValueChangeListener` 的完整实现：本 Frame 同步分发 + 同源 `BroadcastChannel` + 跨源 Server `exposeBinding` 先写值镜像再触发通知。 |
