# 工具与异常参考

本参考对应 `mcp-xxt/server/src/tools.ts`、`types.ts`、`run-manager.ts` 和 `adapters.ts`。版本变化时以已连接 MCP 的 schema、实际回执和能力探测为准，不用旧注释覆盖当前行为。

## 工具输入与关键输出

名称不含客户端附加的命名空间；`?` 表示可省略。

| 工具 | 输入 | 关键输出或约束 |
|---|---|---|
| `open_login` | `{}` | `status`、`detail`，必要时顶层截图；自动尝试本地配置账号 |
| `get_login_status` | `{}` | `loggedIn`、`detail` |
| `open_page` | `{url}` | 最终 `url`、`title`；命中课程学习页时有 `session_id` |
| `start_work` | `{}` | 手动入口的 `run_id`，立即返回；页面桥后续注册题目 |
| `wait_next_work` | `{timeout_s?, request_id?}` | `event`、可选 `run_id` / `session_id` / `reason`；省略超时默认 60 秒 |
| `get_status` | `{run_id?}` | run 状态、`mode`、`capabilities`、`work_completed`、`questions`、`submit_uncertain` / `submit_error`；省略 ID 取当前活跃 run |
| `get_pending_questions` | `{run_id}` | `structuredContent.questions`；顶层 `content` 包含图片或失败文字 |
| `submit_answer` | `{run_id, question_id, answer}` | `question_id`、接收后的 `status` |
| `submit_answers` | `{run_id, answers:[{question_id, answer}]}` | `results:[{question_id, ok, error?}]`，可能部分成功 |
| `submit_paper` | `{run_id, mode:"temporary"或"confirm"}` | `status`、`evidence`；失败也检查 `isError` 和结构化返回 |
| `abort_run` | `{run_id, reason?}` | `run_id`、`status`；仅 `reason:"manual-saved"` 对应 `released` |

没有 `session_id`、事件 cursor、题目列表分页参数可传给 `wait_next_work`。它隐式使用当前 session。重新 `open_page` 课程学习页会创建新 session 并终止旧等待；不要为了轮询进度反复导航。

手动页当前识别以下路径，不意味着所有页面都具备相同保存能力：

- `/mooc2/work/dowork`
- `/mooc2/exam/preview`
- `/page/quiz/stu/answerQuestion2`

### 回填参数示例

以下 ID 仅为示意，调用时换成工具实际返回的值；四道题可在分别入队时分批提交。

```json
{
  "run_id": "实际 run_id",
  "answers": [
    {"question_id": "单选题实际 ID", "answer": "B"},
    {"question_id": "多选题实际 ID", "answer": ["A", "C"]},
    {"question_id": "单空题实际 ID", "answer": ["C#"]},
    {"question_id": "不确定题实际 ID", "answer": null}
  ]
}
```

## 题目状态与审核含义

| 状态 | 含义 | 处理 |
|---|---|---|
| `pending` | 等待答案 | 可以回填；关注权威 deadline |
| `answered` | server 收到答案，尚无最终页面应用结果 | 查状态，不能重复回填 |
| `applied` | 页面报告已应用，通常 `finish:true` | 审核实际答案；不等于答对 |
| `applied-failed` | 匹配或 DOM 应用失败 | 查看 `detail`，列为异常；同一题终态不能重填 |
| `timeout` | 等待超时 | 列为未完成；迟到的页面结果仍可能将其更新为 applied 或 applied-failed |
| `skipped` | 显式 `null` 跳过 | 列为跳过，不宣称已答 |
| `unsupported` | 当前题型不支持 | 交给人工，不能伪造回填 |

`resolved:true` 表示题目已终结等待，不等于答案成功。`get_status.questions[].answer` 是 agent 原始回填答案，不是平台判分结果。审核不能只用本地生成的答案替代服务器状态。

图片由 server 使用共享登录 cookie 的请求下载；单图超过 4 MiB 会跳过并给出文字提示。下载失败项没有 image block，不能简单把所有题与图片按固定个数配对。一个题目可能含多张图；结合该题的 URL 列表和失败文字对应。只有实际获取到图像时才做视觉判断。

## run 生命周期

- 通常为 `running → ready_for_review`，条件是全部题目终态且收到 `work-completed`。
- 课程暂存：`saving → saved-and-left`，该 run 已结束；后续等待下一测验。
- 手动暂存：`saving → saved`，保留该 `run_id` 以便收尾或授权后的交卷；结束暂存任务时 `abort_run(reason:"manual-saved") → released`。
- 交卷成功：`submitting → finished`。
- 普通中止或 frame 失效：`aborted`。

`finished`、`saved-and-left`、`released`、`aborted` 是终态，不再回填、提交或重复中止。`saved` 不属于终态，不依赖省略 ID 的 `get_status` 找回它，应保留原 `run_id`。

## 异常恢复

| 情况 | 动作 |
|---|---|
| `start_work` 报已有 run | `get_status({})` 恢复当前工作；不要未经用户意图丢弃进度 |
| 新建 run 暂无题目、pending 为空 | 查 `get_status`，短间隔等待题目或完成事件，避免忙轮询；不调用提交强行推进 |
| 回填格式校验失败 | 修正格式，再查题目仍为 pending 才重试；空字符串应改为有效答案或显式 null |
| 回填调用超时或批量部分失败 | 逐题查当前状态；仅重试仍 pending 且原因已修复的题 |
| `submit_paper` 返回 `unsupported` | 能力不足，run 保留；向用户说明需人工保存/提交，确认完成后收尾；不自行点击按钮绕过能力约束 |
| `submit_paper` 返回 `failed` | run 回到 `ready_for_review`；读取 evidence / submit_error，修复明确原因后才重试，原因不明则停止并报告 |
| `uncertain` 或 `submit_uncertain:true` | server 已尝试内部结果核验但未确认；停止再次提交，报告证据并请求用户核对页面；按核实结果收尾 |
| 导航、关闭或 frame 重建导致 aborted | 旧 ID 作废，不继续写入；检查实际页面，按用户原范围重新建立流程 |
| `traversal-blocked` | 报告原因和已保存进度；禁止通过反复重开 session、abort 或刷媒体规避重进限制 |

`readResult` 是 server 内部能力，**没有**公开 `read_result` MCP 工具。结果不确定时不要编造工具调用。`abort_run` 仅结束流程，不证明保存或提交结果，也不能回滚平台操作。

长时间无进展时检查已知 run 状态、登录提示、最后一条错误和单题 deadline；同一原因持续出现就报告阻塞，避免无限重试。终止事件正常接收后结束该 session 的等待循环，即使后续 wait 可能返回 still-waiting。
