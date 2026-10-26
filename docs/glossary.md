# 术语表（mcp-xxt 二次开发）

> 状态：草稿，随访谈轮次更新。记录讨论中用到的领域词汇，避免歧义。

## ocsjs 原有概念

| 术语 | 含义 |
|---|---|
| **Project / Script** | easy-us 框架的两级结构：Project 按"平台"组织（域名列表 + scripts）；Script 是具体功能单元（matches 路由 + configs 配置 + methods 方法 + onstart/onactive/oncomplete/onrender/onhistorychange 生命周期） |
| **OCSWorker** | core 包的自动答题引擎。输入 `WorkOptions`（root/elements/answerer/work），`doWork()` 双线程（搜题并发 + 作答串行）执行，`uploadHandler` 决定提交策略 |
| **answerer（查题器）** | `WorkOptions.answerer`：输入题目元素，返回 `SearchInformation[]` 的函数。原实现 = `createCommonAnswerer` → 本地缓存 → `defaultAnswerWrapperHandler` 请求远程题库 |
| **AnswererWrapper（题库配置）** | 用户配置的远程题库描述（url/method/handler 字符串等），本项目二开中将被废弃（不使用原有题库搜题） |
| **work（工作器）** | `WorkOptions.work`：默认工作器（`DefaultWork.handler` 回调点选/填写）或自定义函数 |
| **root / elements** | root = 题目根元素（选择器或元素数组）；elements = 题目内部 DOM 映射（约定键 title/options/type） |
| **commonWork** | scripts 包的通用答题编排：面板/倒计时/暂停重试/题库预检，平台脚本只传 `workerProvider` 工厂 |
| **resolvers** | 四题型纯函数匹配器（single/multiple/judgement/completion）：归一化精确 → 相似度（0.6 阈值 + 消歧）→ 纯 ABCD 兜底。输入是字符串数组，无 DOM 依赖 |
| **SearchInformation** | 题库命中结果契约 `{ results: [{question, answer, extra_data}], name, error }`。MCP answerer 若保持此结构，core 匹配管线可原样复用 |
| **题库缓存** | `BackgroundProject.scripts.data`，本地缓存搜过的题（上限 200），搜题时缓存优先 |
| **UMD bundle（dist/index.js）** | `packages/scripts` 经 vite 构建的全局名为 `OCS` 的库产物；`.user.js` = bundle + `@ocsjs/utils` 生成的油猴元数据 + `entry.js` |
| **GM API / $gm** | 油猴注入的 13 个 `GM_*` 接口（存储/通知/跨域请求/标签页等）；easy-us 的 `$gm` 是其封装，`$store` 的存储后端依赖 GM_setValue/GM_getValue |
| **easy-us** | 脚本框架依赖（v1.0.15）：Project/Script/start + `$store/$elements/$ui/$modal/$message/$menu/cors`。模块顶层继承 HTMLElement，加载时即需要 DOM 全局 |
| **RemotePlaywright** | core 包与 OCS 桌面端（localhost:15319）通信的远程页面控制封装 |
| **密文字体解密** | 超星 font-cxsecret / 雨课堂动态字体的位图特征匹配反解（FontDecryptor） |

## 二开新增概念（已确认）

| 术语 | 含义 |
|---|---|
| **MCP answerer** | 替换原题库搜题的查题器：把题目注册进待答队列并 await MCP 侧 `submit_answer` 回填；返回 `SearchInformation[]`（name: 'mcp-agent'），core 匹配管线原样复用（ADR-0004） |
| **run（答题会话）** | 一次作业/考试流程实例，`start_work` 创建并返回 run_id，是全部流程类工具的句柄（ADR-0007） |
| **run 状态机** | `running` → `ready_for_review`（逐题终态齐 + work-completed 事件）→（temporary）`saving`→`saved`；课程模式 saved 即 `saved-and-left` 终态（预期导航、释放互斥、不可 confirm），手动模式可再（confirm）`submitting`→`finished`；异常 `aborted` / 人工完成 `released`（ADR-0017/0020）。单 run 互斥（ADR-0013）；`work-detected` 确认制自动建 run |
| **平台适配器** | 每类页面的 `start/save/submit/readResult/abort` 接口与能力标志；无独立暂存能力时 temporary 诚实返回该事实（ADR-0018） |
| **MCP 模式标记** | GM shim 阶段设置的不可变标记，先于一切框架生命周期；媒体硬禁用据此判断，不用桥存在性判断（ADR-0019） |
| **exposeBinding 通信** | server 经 `browserContext.exposeBinding` 接收各 frame 事件（含来源），权威 run 状态只在 server；同源 top 桥仅为局部优化（ADR-0017） |
| **saved-and-left** | 课程模式 temporary 的终态：暂存成功即标记预期导航、释放单 run 互斥、不可再 confirm（ADR-0020） |
| **released** | 人工保存场景的终态：abort_run(reason:'manual-saved')，区别于异常中止的 aborted（ADR-0020） |
| **通知 shim** | GM_addValueChangeListener 的必备实现：写入时本 frame 同步分发（remote=false）；同源 frame 经 BroadcastChannel、跨源 frame 经 server 中继（**先写值镜像、再 remote=true 通知**，因跨源 localStorage 不共享）；easy-us cors/面板通信全链路依赖且无超时，no-op 会静默挂起（ADR-0020/0021） |
| **JSON 数组编码** | 填空 string[] 以 JSON.stringify 编码进 answer，走 splitAnswer 既有的 JSON 解析分支无损还原；分隔符 join 会丢失答案边界（`["C#"]` 被静默错拆），已废弃（ADR-0021） |
| **事件信封与游标** | 遍历级事件（session_id+单调 event_id，可无 run_id）与 run 级事件（+run_id）两类信封；server 按 per-session 游标每事件至多投递一次，wait_next_work 隐式续读（ADR-0020） |
| **question-result / work-completed** | 逐题应用结果事件（applied/applied-failed/timeout/skipped/unsupported）与整卷作答完成事件；ready_for_review 的唯一迁移依据（ADR-0020） |
| **取消 signal** | 经 WorkContext 传入 resolver DOM 包装层与平台 handler，每次 handler 调用 / DOM 写入前检查；区分"取消发起"与"旧任务已停止写入"（ADR-0020） |
| **计数身份化** | 重进计数按 course/clazz/chapter/job（jobid）身份区分，同章节不同测验不累计，取得进展即重置（ADR-0020） |
| **submit_paper mode** | `'temporary'` 触发页面暂存（默认安全态）；`'confirm'` 真正交卷（ADR-0007）。注意：章节测验 temporary 不标记任务点通过（ADR-0015） |
| **wait_next_work** | 阻塞工具：课程遍历模式下挂起至下一个测验 run 就绪；超时返回 `still-waiting`（幂等重调）；课程结束返回 `course-finished`（ADR-0015） |
| **work-detected 事件** | `JobRunner.chapter()` 入口经 `__mcpNotify` 上报，server 收到后自动创建 run（start_work 的自动入口）（ADR-0015） |
| **course-finished 事件** | `study()` 完成分支上报，标识整课遍历结束（ADR-0015） |
| **双入口 start_work** | 手动入口（agent 调用，独立作业/考试页）与自动入口（work-detected 事件建 run）（ADR-0015） |
| **遍历模式默认 mode='next'** | 顺序推进下一小节；不用 job 模式（媒体任务点禁用后永不完成会卡住）（ADR-0015） |
| **单题超时** | MCP answerer 等待回填上限 300s，超时标记 unanswered 继续流程（ADR-0007） |
| **题目抓取管线** | root 定位 → elements 解析 → 题型识别 → 文本/图片构造（titleTransform/extractTextWithImages）→ env 组装 |
| **GM shim** | 注入式运行的 GM_* 接口兼容层：存储→localStorage（跨源 frame 经 server 中继写值镜像）、通知→本 frame 分发 + 同源 BroadcastChannel / 跨源 server 中继、tab→localStorage 前缀直通（单标签页）、GM_xmlhttpRequest 不做页面侧假实现（图片下载走 server `context.request`）（ADR-0001/0019/0020/0021） |
| **禁用而非删除** | 学习类行为（视频/PPT/阅读/倍速）在 MCP 模式关闭，源码与跳转框架全保留（ADR-0009） |
| **自动跳转框架** | cx study 脚本内的 searchJob/getNext/mode 跳转体系，MCP 模式下作为到达章节测验的导航骨架保留（ADR-0009） |
