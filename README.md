# mcp-xxt

基于 `ocsjs` 二次开发的**超星学习通（Chaoxing）MCP 流程化答题系统**。通过内置有头 Playwright 浏览器注入改造后的单文件 IIFE 脚本，将传统的“题库自动搜题”改造为由 AI Agent 驱动的**拉取式答题、逐题审核与显式暂存/交卷**工作流。

> **文档索引**：[系统总体设计文档](docs/design.md) · [开发基准文档 (v1.2)](docs/开发文档.md) · [领域术语表](docs/glossary.md) · [Server 说明](server/README.md) · [配套 Skill 说明](skills/mcp-xxt/SKILL.md)

---

## 目录

1. [项目简介](#1-项目简介)
2. [项目构建](#2-项目构建)
3. [MCP 安装与配置](#3-mcp-安装与配置)
4. [Skill 安装](#4-skill-安装)
5. [使用示例](#5-使用示例)
6. [开源许可与致谢](#6-开源许可与致谢)

---

## 1. 项目简介

`mcp-xxt` 将开源网课脚本框架 `ocsjs`（以 vendor fork 形式维护于 `ocsjs/`）与独立的 TypeScript MCP Server（`server/`）相结合，面向超星学习通（`cx`）提供可控、可审核、安全的自动化答题能力。

### 核心特性

- **拉取式 Agent 答题协议**：保留 `ocsjs` 成熟的题目 DOM 抓取、密文字体解密、四题型纯函数匹配器（单选 `single` / 多选 `multiple` / 判断 `judgement` / 填空 `completion`）与 DOM 回填管线，废除远程题库搜题，由 Agent 通过 `get_pending_questions` 拉取题目并经 `submit_answer` / `submit_answers` 回填答案。
- **双模式工作流驱动**：
  - **课程遍历模式（自动入口）**：打开课程学习页后，由页面脚本按 `mode='next'` 自动推进章节，遇到章节测验自动上报 `work-detected` 创建答题会话（`run`），Agent 通过 `wait_next_work` 阻塞等待并介入作答。
  - **独立作业模式（手动入口）**：打开独立作业或随堂练习页后，由 Agent 显式调用 `start_work` 动态探测页面保存能力并启动答题闭环。
- **多模态图片题支持**：自动提取题干与选项中的图片并替换为 `[图片N]` 占位符，由 Server 复用浏览器登录 Cookie 下载原图并以 MCP 顶层 `image` Content Block 传递给具备视觉能力的模型。
- **刷课行为硬禁用**：音视频播放、倍速、PPT、阅读时长等“刷课”功能在代码分支入口处**硬禁用**（仅保留自动跳转框架作为寻找章节测验的导航骨架）。
- **严格的人机安全边界**：
  - **永不自动交卷**：默认执行 `submit_paper(mode='temporary')` 暂存答案；仅在生成 `get_status` 逐题审核单且获得用户明确交卷授权后，才可调用 `mode='confirm'` 正式交卷。
  - **保存/交卷防竞态与子 Frame 身份核验**：每次 `submit_paper` 生成独立 `submitAttemptId` 与不可变命令快照；Ajax 响应先于平台回调捕获并缓存原始 jQuery/Document 引用防止跨源导航 `SecurityError`；交卷结果不确定（`uncertain`）时通过绑定测验子 `iframe` 与作业身份（`jobId`/`workId`/`workAnswerId`）的 `readResult` 探针二次核验，杜绝盲目重提与跨章误判。
  - **验证码与风控转人工**：内置持久化 Profile（`server/.browser-profile/`）保存登录态；遇到滑块验证码、扫码或平台风控一律截屏返回 `need-human` 交由人工在有头浏览器窗口处理，绝不内置打码或风控绕过逻辑。
  - **人类监督窗口**：保留裁剪后的页面悬浮面板，实时展示题目填充状态与运行日志。

### 系统架构

```
Agent / Skill (客户端编排)
   │  MCP over stdio (@modelcontextprotocol/sdk，stdout 协议 / stderr 日志)
   ▼
server/ (Playwright 有头 Chromium + 持久 Profile + 权威 Run 状态机 + 11 个 MCP 工具)
   │  addInitScript 注入单文件 bundle.iife.js + exposeBinding('__mcpEvent')
   ▼
ocsjs/ (entry-mcp 模式，页面主世界运行)
   └─ GM Shim (localStorage + 三层跨源通知中继) → Frame 本地桥 → 自动跳转骨架 / MCP Answerer
```

### 仓库结构

| 路径 | 说明 |
|---|---|
| `ocsjs/` | `ocsjs` vendor fork（`mcp` 分支），包含 F1～F11 改造点与 `packages/scripts/src/mcp/` 桥接实现 |
| `server/` | 独立 TypeScript MCP Server 工程，包含 Playwright 宿主、权威状态机、答案编码器、11 个工具定义与回归测试套件 |
| `skills/mcp-xxt/` | 配套 Agent Skill，定义双入口编排流程、题型答案格式、逐题审核单规范与异常恢复策略 |
| `docs/` | [系统总体设计文档](docs/design.md)、[开发基准文档](docs/开发文档.md)与[领域术语表](docs/glossary.md) |

---

## 2. 项目构建

### 环境要求

- **Node.js**：`>= 20.0.0`（含 `npm`）
- **图形桌面环境**：Linux（需具备 X11 / Wayland 会话，如 `DISPLAY=:0`）、macOS 或 Windows 桌面环境（Playwright 以**有头模式 `headless: false`** 运行 Chromium，以便人工监督与处理验证码）

### 构建步骤

#### 第一步：构建 `ocsjs` 页面注入 Bundle

在 `ocsjs/` 目录下安装核心与脚本包依赖，并打包生成单文件 IIFE Bundle（`ocsjs/packages/scripts/dist-mcp/bundle.iife.js`）：

```bash
cd ocsjs
npm install -w packages/core -w packages/scripts
node scripts/build-mcp.js
```

> 若处于受限网络环境，可指定国内镜像源安装依赖：
> ```bash
> env -u http_proxy -u https_proxy npm_config_registry=https://registry.npmmirror.com npm install -w packages/core -w packages/scripts
> ```

#### 第二步：安装 `server` 依赖与 Chromium 浏览器

进入 `server/` 目录安装服务端依赖及 Playwright Chromium 内核：

```bash
cd ../server
npm install
npx playwright install chromium
```

> 国内网络可使用镜像加速下载 Chromium 二进制包：
> ```bash
> PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright npx playwright install chromium
> ```

#### 第三步：同步 Bundle、编译 Server 并运行测试验证

将第一步生成的 `bundle.iife.js` 同步到 `server/dist-bundle/`，编译 TypeScript 源码至 `server/dist/`，并运行测试套件验证：

```bash
npm run sync-bundle
npm run build
npm test              # 运行 4 套 Node 单元测试（answer-encoding / run-manager / traversal / submit-races）
npm run test:browser  # （可选）运行 Playwright Chromium 真实浏览器注入与提交流程回归测试
```

#### 第四步：（可选）配置账号

   创建 `server/config/account.json`，填入学习通手机号/学号与密码；若不配置，调用 `open_login` 时可在弹出的浏览器窗口中手动或扫码登录（登录态会自动保存在 `server/.browser-profile/` 中）：
   ```json
   {
     "username": "你的手机号或学号",
     "password": "你的密码"
   }
   ```

---

## 3. MCP 安装与配置

`mcp-xxt` 采用标准 **stdio** 传输协议运行，入口文件为编译后的 `/绝对路径/mcp-xxt/server/dist/index.js`（无 HTTP 端口；`stdout` 专用于 MCP JSON-RPC 通信，业务日志输出至 `stderr`）。

### 方式一：通用 JSON 配置文件（Claude Desktop / Cursor / Windsurf / ZCode 等）

在客户端的 MCP 配置文件中添加 `mcp-xxt` 服务（请将路径替换为本仓库在您机器上的实际绝对路径）：

```json
{
  "mcpServers": {
    "mcp-xxt": {
      "command": "node",
      "args": [
        "/绝对路径/mcp-xxt/server/dist/index.js"
      ]
    }
  }
}
```

### 方式二：命令行客户端注册（Codex CLI / Claude Code 等）

- **Codex CLI**（编辑 `~/.codex/config.toml`）：
  ```toml
  [mcp_servers.mcp-xxt]
  command = "node"
  args = ["/绝对路径/mcp-xxt/server/dist/index.js"]
  ```
- **Claude Code CLI**：
  ```bash
  claude mcp add mcp-xxt -- node /绝对路径/mcp-xxt/server/dist/index.js
  ```

### MCP 工具面一览（11 个工具）

| 工具名 | 作用说明 |
|---|---|
| `open_login` | 打开超星登录页并尝试配置的账号密码；遇验证码/风控自动截屏返回 `need-human` 转人工处理 |
| `get_login_status` | 检测当前持久化 Profile 是否已具备有效登录 Cookie |
| `open_page` | 导航至目标 URL；命中课程学习页（`/mycourse/studentstudy`）时在导航前预创建并绑定新遍历会话（含课程/班级身份 `courseId`/`clazzId`），返回 `session_id` |
| `start_work` | **手动模式入口**：在独立作业/练习页动态探测保存能力并显式启动答题，返回 `run_id` |
| `wait_next_work` | **课程遍历入口**：挂起等待下一个章节测验就绪（`work-ready`）或遍历终止事件（支持 `request_id` 幂等重试；首个终止事件持久保留，后续调用仍返回该终态） |
| `get_status` | 查询指定或当前活跃 `run` 的状态、动态能力（`auto_save`/`auto_submit`）、逐题结果与 `traversal` 遍历状态；缺省 `run_id` 且无活跃 Run 时正常返回 `status: 'no-run'`（非错误） |
| `get_pending_questions` | 获取待答题目列表与选项，题图由 Server 下载后作为顶层 `image` Content Block 返回 |
| `submit_answer` | 回填单道题答案（填空传 `string[]`，跳过传 `null`） |
| `submit_answers` | 批量回填多道题答案（逐题独立返回成功/失败） |
| `submit_paper` | 暂存或交卷：`mode='temporary'` 触发页面暂存（默认安全态）；`mode='confirm'` 正式交卷；结果不确定时经子 Frame `readResult` 探针二次核验，无法确认则返回 `submit_uncertain` 严禁盲目重提 |
| `abort_run` | 终止当前 `run` 并取消页面侧一切等待与 DOM 写入；`reason='manual-saved'` 时记为 `released` 终态 |

---

## 4. Skill 安装

仓库内的 [`skills/mcp-xxt/`](skills/mcp-xxt/) 是专为 `mcp-xxt` MCP Server 编写的配套 **Agent Skill**，定义了课程遍历与独立作业双入口选择、四题型答案格式约束、多模态题图配对、逐题审核单生成规范以及暂存/交卷的安全边界。

### Skill 目录结构

```
skills/mcp-xxt/
├── SKILL.md                   # 主技能指令：入口选择、取题回填规范、审核单与交卷安全边界
├── agents/
│   └── openai.yaml            # 界面元数据与对 mcp-xxt MCP Server 的工具依赖声明
└── references/
    ├── connection.md          # 连接排查与本地构建指南（按需加载）
    └── protocol.md            # 11 个工具的详细输入输出、状态机生命周期与异常恢复矩阵
```

### 安装方法

将 `skills/mcp-xxt` 复制或软链接到您的 AI 客户端 Skill 发现目录中：

1. **安装到个人全局 Skill 目录（以 Codex 默认目录 `~/.codex/skills/` 为例）**：
   ```bash
   mkdir -p ~/.codex/skills
   # 推荐使用软链接，方便随仓库更新：
   ln -s "$(pwd)/skills/mcp-xxt" ~/.codex/skills/mcp-xxt
   # 或直接复制：
   # cp -r skills/mcp-xxt ~/.codex/skills/mcp-xxt
   ```

2. **安装到其他支持 `.agents/skills` 的客户端或工作区**：
   ```bash
   mkdir -p ~/.agents/skills
   ln -s "$(pwd)/skills/mcp-xxt" ~/.agents/skills/mcp-xxt
   ```

> **注意**：Skill 仅提供客户端侧的工作流编排说明，安装 Skill 后仍需确保已完成第 2、3 节的 **项目构建** 与 **MCP Server 连接配置**。

---

## 5. 使用示例

### 5.1 自然语言交互示例（配合 `$mcp-xxt` Skill）

当客户端已连接 `mcp-xxt` MCP Server 并加载 `mcp-xxt` Skill 后，可以直接在对话中通过 `$mcp-xxt` 触发不同工作流：

#### 场景 A：处理独立作业页（答题 + 生成审核单 + 暂存，不交卷）

> **用户输入**：
> ```text
> 使用 $mcp-xxt 处理这个超星作业，完成作答后生成逐题审核单并暂存，不要交卷：
> https://mooc1.chaoxing.com/mooc-ans/mooc2/work/dowork?courseId=265265735&classId=150811059&cpi=508143193&workId=56798381&answerId=55993692&standardEnc=6a4f1ced30fb2abef116a5542cf505cc&enc=3ce264825829eaf56765c81ff8714c9a
> ```
>
> **Agent 执行流程**：
> 1. 调用 `get_login_status()` 检查登录态（未登录则调用 `open_login()` 并在需要时提示用户完成验证码）；
> 2. 调用 `open_page({ url: "<作业 URL>" })` 打开作业页；
> 3. 调用 `start_work()` 启动手动答题 `run`，并经 `get_status` 读取到 `capabilities: { auto_save: true, auto_submit: false }`；
> 4. 循环调用 `get_pending_questions` 获取增量入队的题目（及顶层题图），推理答案后通过 `submit_answers` 回填；
> 5. 轮询 `get_status` 直至 `status === "ready_for_review"` 且 `work_completed === true`，向用户输出包含题号、题干摘要、回填答案及 `applied` 状态的**逐题审核单**；
> 6. 调用 `submit_paper({ run_id, mode: "temporary" })` 触发页面 `saveWork()` 暂存，确认返回 `status: "saved"` 及 HTTP 200 证据；
> 7. 调用 `abort_run({ run_id, reason: "manual-saved" })` 使 Run 进入 `released` 终态，释放单 Run 互斥并向用户汇报结果。

#### 场景 B：课程学习页顺序遍历章节测验（自动跳过视频/阅读，逐章暂存）

> **用户输入**：
> ```text
> 使用 $mcp-xxt 打开下面的课程学习页，遍历所有章节测验进行作答和暂存（全部使用 temporary 暂存，不正式交卷），每个测验完成后给我一份审核小结：
> https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=1249930684&courseId=267298804&clazzid=155243931&cpi=508143193&enc=8fcf7639cfb4a7411988de939dbd9546&mooc2=1
> ```
>
> **Agent 执行流程**：
> 1. 验证登录态后调用 `open_page({ url: "<课程学习页 URL>" })`，获得遍历会话 `session_id`；
> 2. 循环调用 `wait_next_work({ timeout_s: 60, request_id: "<唯一请求 ID>" })`（期间视频、PPT、阅读任务点由页面守卫自动跳过）；
> 3. 每当收到 `{ event: "work-ready", run_id }` 时，执行“取题 → 推理回填 → `get_status` 确认 `ready_for_review` 并输出审核单 → `submit_paper({ run_id, mode: "temporary" })`”；
> 4. 课程模式下暂存成功后自动返回 `saved-and-left` 终态并释放页面继续跳转下一章；
> 5. 重复步骤 2～4，直到 `wait_next_work` 返回 `course-finished`（整课遍历完成）或 `traversal-blocked`（如章节锁定/存在未完成任务点），输出整课汇总报告。

#### 场景 C：仅提取题目与解析（只读模式，不回填不修改页面）

> **用户输入**：
> ```text
> 使用 $mcp-xxt 提取这个作业里的所有题目和选项，给出你的参考答案和解析，但不要往页面里回填，也不要保存：
> <作业 URL>
> ```
>
> **Agent 执行流程**：
> 打开页面并建立 `run` 读取题目后，调用 `abort_run({ run_id, reason: "extract-only" })` 安全中止 `run`，仅在对话中展示题目与解析，页面保持零写入。

---

### 5.2 底层 MCP 工具调用序列与参数示例

以下展示客户端直接调用 MCP 工具时的标准协议载荷示例：

#### 1. 检查登录并打开课程页

```json
// 1) 检查登录状态
// Tool: get_login_status
{}
// -> 返回: { "loggedIn": true, "detail": "检测到登录 cookie（UID）" }

// 2) 打开课程学习页（自动创建遍历 session）
// Tool: open_page
{
  "url": "https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=1249930684&courseId=267298804&clazzid=155243931&cpi=508143193"
}
// -> 返回: { "url": "...", "title": "学生学习页面", "session_id": "2ea5ff27-8b1c-4d3a-9e12-1a2b3c4d5e6f" }
```

#### 2. 等待章节测验就绪并拉取题目

```json
// 3) 等待脚本遍历到达章节测验
// Tool: wait_next_work
{
  "timeout_s": 60,
  "request_id": "req-chapter-01"
}
// -> 返回: { "event": "work-ready", "run_id": "009c8e7b-d374-4416-a0a6-a22f5fa8276a", "session_id": "2ea5ff27-..." }

// 4) 拉取当前待答题目
// Tool: get_pending_questions
{
  "run_id": "009c8e7b-d374-4416-a0a6-a22f5fa8276a"
}
```

#### 3. 批量回填四类题型答案（`submit_answers`）

- **单选题（`single`）**：传选项字母（如 `"B"`）或准确选项全文；
- **多选题（`multiple`）**：传大写字母数组（如 `["A", "C"]`）、字母串（`"AC"`）或选项全文数组；
- **判断题（`judgement`）**：传 `"正确"` 或 `"错误"`；
- **填空题（`completion`）**：传 `string[]`（每空一项，Server 自动执行 `JSON.stringify` 无损编码，即使答案内含 `#`、`===` 等分隔符如 `["C#"]` 也不会被错拆）；
- **跳过题目**：传 `null`。

```json
// Tool: submit_answers
{
  "run_id": "009c8e7b-d374-4416-a0a6-a22f5fa8276a",
  "answers": [
    { "question_id": "q-101", "answer": "B" },
    { "question_id": "q-102", "answer": ["A", "C", "D"] },
    { "question_id": "q-103", "answer": "正确" },
    { "question_id": "q-104", "answer": ["C#", "面向对象"] },
    { "question_id": "q-105", "answer": null }
  ]
}
```

#### 4. 查询审核状态并暂存试卷（`get_status` → `submit_paper`）

```json
// 5) 轮询直至 status === "ready_for_review" 且 work_completed === true
// Tool: get_status
{
  "run_id": "009c8e7b-d374-4416-a0a6-a22f5fa8276a"
}

// 6) 执行暂存（默认安全态 temporary；若用户已明确授权交卷则传 "confirm"）
// Tool: submit_paper
{
  "run_id": "009c8e7b-d374-4416-a0a6-a22f5fa8276a",
  "mode": "temporary"
}
// -> 课程模式返回:
// {
//   "status": "saved-and-left",
//   "evidence": "暂存请求响应 status=true msg=保存成功！（HTTP 200）",
//   "run_id": "009c8e7b-d374-4416-a0a6-a22f5fa8276a"
// }
```

---

## 6. 开源许可与致谢

本项目采用 **MIT License**，完整许可条款见 [LICENSE](LICENSE)。允许在遵守许可条款、保留版权及许可声明的前提下使用、修改、分发和商业使用。

本项目基于 [ocsjs](https://github.com/ocsjs/ocsjs) 二次开发，保留并修改了其页面脚本与核心答题流程，新增 MCP Server、页面桥接和配套 Skill。

- ocsjs 原始代码：Copyright (c) 2022 enncy，原始 MIT 许可保留于 [ocsjs/LICENSE](ocsjs/LICENSE)。
- 本项目的修改与原创新增部分：Copyright (c) 2026 shirohapantsu，采用 MIT License。
- 第三方依赖及资源仍适用各自的许可和版权声明。

分发源码或包含本项目代码的构建产物时，应一并携带适用的版权及许可声明。软件按“原样”提供，不附带任何保证，具体以 LICENSE 中的条款为准。
