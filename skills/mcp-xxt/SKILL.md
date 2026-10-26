---
name: mcp-xxt
description: "通过 mcp-xxt MCP 操作超星学习通：提取章节测验或作业题目、处理图片题、回填答案、生成逐题审核单并暂存；在用户明确授权时交卷。用户提到学习通、超星、Chaoxing、章节测验、课程遍历或 mcp-xxt 答题流程时使用。不用于刷视频、刷阅读时长或其他平台。"
---

# 超星学习通 MCP

使用 `mcp-xxt` 提供的工具编排流程。页面注入、题目解析、DOM 回填和导航由 MCP server 执行；不要另建浏览器自动化、直接调用学习通保存接口或恢复旧题库逻辑。

## 开始前

- 发现 `mcp-xxt` 的实际工具名称；客户端可能添加命名空间前缀。工具名和输入以当前 MCP schema 为准。找不到工具时读取 [连接与构建](references/connection.md)，报告连接缺失；不要假装已经登录或答题。
- 使用用户提供的课程学习页或作业链接。服务没有 `list_courses`、`list_homework` 等发现工具；缺少链接且上下文没有可用链接时向用户索取。
- 识别范围：只取题、回填、暂存，还是已明确授权交卷。默认完成回填、审核和暂存；“答题”“完成作业”不自动等于授权交卷。既有交卷授权适用时继续执行，不重复索要同一授权。
- 先用 `get_login_status()` 复用登录态；未登录时 `open_login()`。验证码、扫码、风控或人工登录提示交由用户处理，完成后复查登录态。
- 同时只处理一个 run。恢复中断流程时先 `get_status({})` 查找当前 run，再决定继续还是按用户意图中止；不要为了消除互斥错误丢弃现有进度。

## 选择入口

### 课程学习页：顺序遍历章节测验

1. `open_page({"url":"用户提供的课程学习页 URL"})`，记录实际返回的 `session_id`。典型课程路径是 `/mycourse/studentstudy`。
2. 调用 `wait_next_work({"timeout_s":30,"request_id":"本轮唯一请求 ID"})`；课程模式由页面事件自动建 run，**不调用 `start_work`**。
3. 按返回的 `event` 处理：

   | event | 后续动作 |
   |---|---|
   | `work-ready` | 记录 `run_id`，执行下文的取题、回填、审核流程 |
   | `still-waiting` | 正常等待结果，可再次等待；不能当成整课完成 |
   | `course-finished` | 结束遍历，报告实际处理的测验和结果 |
   | `traversal-blocked` | 停止自动推进，报告 `reason` 和已完成进度 |
   | `page-invalid` | 停止该轮等待，检查登录态、URL 或 session 是否被替换 |

4. 请求因客户端超时而结果丢失时，携带相同 `request_id` 重试；成功收到事件后，下一轮等待用新 ID。事件按 session 游标投递，不会每次重放；丢失 `work-ready` 可用 `get_status({})` 恢复活跃 run。
5. 课程 run 暂存成功返回 `saved-and-left`，随后才等待下一个测验。它是终态，不能再用同一 run 交卷。用户原本已授权交卷时，在本轮审核后选择 `confirm`，不要先暂存离开再尝试 confirm。

只处理用户指定的范围。用户只要求一个章节时，完成该范围后不要主动启动整课答题循环。

### 独立作业或练习页：手动启动

1. `open_page({"url":"用户提供的作业或练习 URL"})`。
2. `start_work()` 获取 `run_id`，然后 `get_status({"run_id":"实际 run ID"})` 读取 `capabilities`。
3. 执行取题、回填、审核。保存与交卷能力取决于当前页面的动态探测；不要把旧文档中的“作业一律不能暂存”当成规则。当前作业页已有 `auto_save=true`、`auto_submit=false` 的实现与验收。
4. 手动模式暂存成功是 `saved`。若任务到此结束，调用 `abort_run({"run_id":"实际 run ID","reason":"manual-saved"})` 收尾，得到 `released`；若用户已授权并且页面支持交卷，可在 `saved` 后交卷。
5. 能力不足返回 `unsupported` 时保持进度，告知用户需要人工保存或提交。只有确认人工保存完成，才用 `reason:"manual-saved"` 释放 run；普通中止使用实际原因。

## 取题与回填

反复获取 `get_pending_questions({"run_id":"实际 run ID"})`，按新增待答题目增量处理，不要等全卷题目都出现才开始答题。只要求提取或讲解时不回填；提取完成后中止本次新建且不再使用的 run，说明没有保存或交卷。

- 题目元数据在 `structuredContent.questions`；题图位于工具结果顶层 `content` 的 image blocks。结合各题 `images` 顺序、题干中的 `[图片N]` 和下载失败文本对应图片，避免图片错配。图片缺失影响解题时明确说明，不能臆造图中内容。
- 题目 ID 使用返回的 `id`，回填参数叫 `question_id`；不要用显示题号或上一轮 run 的 ID。
- 单题从**入队**起约 300 秒等待回填，取题不会重置计时。参考 `get_status` 的 `requestedAt`、`deadline` 安排处理；有把握的题及时回填，不因等待其他题而整批超时。
- 解题依据题干、选项和题图。答案和把握不足的原因分开表达；无法确定且允许跳过时传 `null` 并在审核中列出。不要给答案字符串附加解释或置信度。
- 已有页面答案不代表需要覆盖；只回填本轮待答且在用户范围内的题。

| type | 推荐 answer | 注意事项 |
|---|---|---|
| `single` | `"B"` 或准确选项全文 | 字母按当前选项顺序确定 |
| `multiple` | `["A","C"]`、`"AC"` 或选项全文数组 | 字母用大写；逐项核对，勿混合字母和选项全文 |
| `judgement` | `"正确"` / `"错误"` | 使用与页面选项对应的明确判断文本，不传 JSON 布尔值 |
| `completion` | `["第一空","第二空"]` | 每空一项，数量核对 `blankCount`；单空也推荐数组 |
| `line` / `fill` / `reader` | 不回填 | v1 不支持，列入审核；不要误把 `fill` 当作普通填空 |
| 任意可跳过题 | `null` | 表示跳过整题，不等于清空答案 |

填空数组直接传 JSON `string[]`，由 server 编码。不要自行拼接 `#`、`|`、`;` 等分隔符；例如单空 C# 传 `["C#"]`。数组不能有空项，不能用 `""` 占位保留某一空，也不要自行把数组转成字符串。

调用 `submit_answer` 或 `submit_answers`。批量回填逐题独立成功或失败，要检查 `structuredContent.results` 的每一项。回填返回 `answered` 或 `ok:true` 只表示接收答案；继续查 `get_status` 确认页面应用结果。调用结果丢失时先查状态，只补仍是 `pending` 的题；`answered` 和终态题均不能重复回填。

## 审核与结束

`get_pending_questions` 为空不代表完成。以 `get_status` 的 `status:"ready_for_review"`、`work_completed:true` 和逐题终态为准；`applied-failed`、`timeout`、`skipped`、`unsupported` 也能进入可审核状态，不能报告成全部成功。

在暂存或交卷前，依据最新 `get_status` 生成逐题审核单：题号或 ID、题干摘要、实际答案、应用状态；异常题加 `detail`、跳过原因或待确认项。分清“推理得到答案”“已填入”“已暂存”“已交卷”。`applied` / `finish:true` 只证明页面填入，不证明答案正确。

- **暂存**：在可审核状态使用 `submit_paper({"run_id":"实际 run ID","mode":"temporary"})`，记录返回状态与 `evidence`。暂存不等于交卷，也不保证章节任务点通过。
- **交卷**：已有用户明确授权、审核完成且 `auto_submit` 支持时，使用 `mode:"confirm"`。没有交卷授权则停留在暂存结果，不根据完成率自动交卷。实际参数是 `mode`，不要沿用旧 ADR 示例中的 `confirm:true`。
- **中止**：用户停止或当前 run 无法继续时使用 `abort_run`，普通中止得到 `aborted`。它不会保存答案，也不会撤销已保存或已交卷的结果。
- **回执异常**：`failed` 与 `uncertain` 的处理见 [工具与异常参考](references/protocol.md)。`submit_uncertain:true` 时停止提交重试；页面结果核验是恢复前提。

最终报告列出处理范围、逐题审核单或其文件链接、失败/跳过题、暂存或交卷的实际回执，以及需要用户处理的阻塞。不得把 `traversal-blocked` 当作完成，也不得把 `released` 当作保存成功证据。

## 按需参考

- 输入字段、状态恢复、图片限制和提交异常：读取 [工具与异常参考](references/protocol.md)。
- MCP 未连接、需要安装依赖或重新构建：读取 [连接与构建](references/connection.md)。
- 本 Skill 是客户端编排层；媒体学习、倍速、阅读时长硬禁用，验证码/风控始终人工处理。
