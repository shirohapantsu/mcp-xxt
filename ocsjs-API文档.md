# ocsjs API 文档

> 基于 ocsjs 仓库（v5.2.3）源码提取整理。ocsjs 是一个在线网课辅助工具（浏览器用户脚本 + OCS 桌面端），采用 pnpm monorepo 结构，核心能力是「题库搜题 + 自动答题 + 课程学习自动化」。

---

## 目录

1. [项目架构总览](#1-项目架构总览)
2. [@ocsjs/core — 自动答题引擎](#2-ocsjscore--自动答题引擎)
   - [OCSWorker 答题器](#21-ocsworker-自动答题器)
   - [WorkOptions 及全部类型](#22-workoptions-及全部类型)
   - [CustomOCSWorker 自定义答题器](#23-customocsworker-自定义答题器)
   - [题型解析器 resolvers](#24-题型解析器-resolvers纯函数)
   - [worker 工具函数](#25-worker-工具函数)
   - [题库配置 answer-wrapper](#26-题库配置-answer-wrapper)
3. [@ocsjs/core — 工具库](#3-ocsjscore--工具库)
   - [DOM 搜索 domSearch / domSearchAll](#31-dom-搜索)
   - [答案匹配算法（字符串工具）](#32-答案匹配算法)
   - [request 请求封装](#33-request-请求封装)
   - [$ 通用工具 / StringUtils / $const](#34-通用工具-与-stringutils)
   - [RemotePlaywright 远程浏览器控制](#35-remoteplaywright-远程浏览器控制)
4. [@ocsjs/utils — 用户脚本构建](#4-ocsjsutils--用户脚本构建)
5. [packages/scripts — 平台脚本包](#5-packagesscripts--平台脚本包)
   - [脚本框架模型（easy-us）](#51-脚本框架模型easy-us)
   - [commonWork 通用答题流程](#52-commonwork-通用答题流程)
   - [createCommonAnswerer 搜题器工厂](#53-createcommonanswerer-搜题器工厂)
   - [CommonProject 通用项目（全局配置/结果面板）](#54-commonproject-通用项目)
   - [BackgroundProject 后台项目](#55-backgroundproject-后台项目)
   - [各平台项目（cx/zhs/icourse/icve/yuketang/zjy）](#56-各平台项目)
   - [等待类工具与杂项工具](#57-等待类工具与杂项工具)
   - [题库一键获取 answerer-connect](#58-题库一键获取-answerer-connect)
   - [搜题环境与图片题优化 answerer-env](#59-搜题环境与图片题优化-answerer-env)
   - [题库安全检测](#510-题库安全检测)
   - [UI 组件库](#511-ui-组件库)
   - [字体反解密 font-decrypt](#512-字体反解密-font-decrypt)
6. [使用示例](#6-使用示例)

---

## 1. 项目架构总览

```
ocsjs/
├── packages/core      → @ocsjs/core   核心包（npm 发布），自动答题引擎 + 工具库
├── packages/scripts   → @ocsjs/scripts 平台脚本包（超星/智慧树/慕课等），re-export 全部 core API
└── packages/utils     → @ocsjs/utils  用户脚本(.user.js)构建工具（Node 端）
```

- `packages/scripts/src/index.ts` 中 `export * from '@ocsjs/core'`，因此从 `@ocsjs/scripts` 或打包产物可以拿到全部核心 API。
- 脚本框架基于 **easy-us**（`Project.create` / `new Script()` / `start`），UI/存储/消息依赖 `$store`、`$elements`、`$ui`、`$modal`、`$message`、`$menu`、`$gm`、`cors` 等由 easy-us 提供。
- 数据流：`Script`（平台脚本）→ `commonWork`（通用答题编排）→ `OCSWorker`（答题引擎）→ `defaultAnswerWrapperHandler`（题库请求）→ `resolvers`（题型匹配作答）。

---

## 2. @ocsjs/core — 自动答题引擎

### 2.1 OCSWorker 自动答题器

文件：`packages/core/src/core/worker/worker.ts`

```ts
import { OCSWorker } from '@ocsjs/core'

const worker = new OCSWorker({ /* WorkOptions，见 2.2 */ })

// 启动答题，返回每道题的结果
const results = await worker.doWork({ enable_debug?: boolean })  // Promise<WorkResult[]>

// 答题结果处理器（决定是否提交/保存）
worker.uploadHandler({
  results: WorkResult[],        // doWork 的返回值
  type: WorkUploadType,         // 'save' | 'nomove' | 'force' | number(提交率阈值)
  callback: (finishedRate: number, uploadable: boolean) => void | Promise<void>
})

// 事件（继承 CommonEventEmitter）
worker.on('start' | 'done' | 'close' | 'stop' | 'continuate', () => {})
worker.emit('stop')             // 暂停
worker.emit('continuate')       // 继续
worker.emit('close')            // 关闭
```

**实例属性**

| 属性 | 类型 | 说明 |
|---|---|---|
| `opts` | `WorkOptions` | 构造时传入的配置 |
| `isRunning` | `boolean` | 是否运行中 |
| `isClose` | `boolean` | 是否已关闭 |
| `isStop` | `boolean` | 是否暂停中 |
| `totalQuestionCount` | `number` | 累计题目数量 |

**doWork 内部流程**

1. `emit('start')`，启动 root 元素观察器（可选，见 `rootObserver`）。
2. 按选择器/元素数组定位全部题目根节点（无题目抛出 `未找到任何题目，答题结束。`）。
3. 为每题构建 `WorkContext`（`domSearchAll` 解析 elements、推断题型），回调 `onElementSearched`、`onQuestionDetected`，全部入队后回调一次 `onResultsInit`。
4. **双线程并行**：搜题线程池（数量 = `thread`，默认 1，带线程锁，3 分钟获取锁超时）+ 答题线程（串行，等待每题 `requested === true`，超时 `(timeout_seconds + 10) * 1000` ms）。
5. 每题：`answerer(elements, ctx)` 搜题 → `work`（默认工作器或自定义函数）作答 → 写回 `WorkResult`，回调 `onResultsUpdate`。
6. 结束后 `isRunning = false`，返回结果数组。

**uploadHandler 提交策略**

| type | 行为 |
|---|---|
| `'nomove'` | 忽略，不调用 callback |
| `'force'` | 恒 `callback(rate, true)` |
| `'save'` | 恒 `callback(rate, false)` |
| `number` | `callback(rate, rate >= number)`（按完成率阈值决定是否提交） |

---

### 2.2 WorkOptions 及全部类型

文件：`packages/core/src/core/worker/interface.ts`

```ts
interface WorkOptions<E extends RawElements = RawElements> {
  /** 题目根元素：CSS 选择器字符串 或 HTMLElement[] */
  root: string | HTMLElement[]
  /** DOM 元素解析器，结果可在 ctx.elements 中使用；必须含 options（默认工作器） */
  elements: E
  /** 查题器：返回 SearchInformation[] */
  answerer: AnswererType<E>
  /** 工作器：DefaultWork 对象（默认工作器）或函数（自定义工作器） */
  work: DefaultWork<E> | CustomWork<E>
  /** 搜题线程数，默认 1 */
  thread?: number
  /** 答案分隔符，默认 ['===', '#', '---', '###', '|', ';', '；'] */
  answerSeparators?: string[]
  /** root 元素观察器：元素从页面消失时自动关闭答题（防 SPA 切页后操作游离元素） */
  rootObserver?: RootObserverOptions
  /** 元素搜索完成回调 */
  onElementSearched?: (elements, root) => void | Promise<void>
  /** 题目入队回调（早于搜题，供结果面板占位） */
  onQuestionDetected?: (currentResult, results) => void | Promise<void>
  /** 全部题目入队后回调一次（供面板一次性初始化） */
  onResultsInit?: (currentResult, currentIndex, results) => void | Promise<void>
  /** 搜题结果回调（已声明，当前版本未触发） */
  onAnswerSearched?: (searchInfo, currentResult, currentIndex) => void | Promise<void>
  /** 答题结果更新回调 */
  onResultsUpdate?: (currentResult, currentIndex, results) => void | Promise<void>
}
```

```ts
/** 默认工作器（推荐） */
interface DefaultWork<E> {
  /** 题目类型：字符串 | 函数 | 不传则自动推断（radio/checkbox/textarea 计数） */
  type?: QuestionTypes | ((ctx: WorkContext<E>) => QuestionTypes)
  /** 选项文本提供器：默认 o.innerText；图片题等场景可自定义 */
  optionText?: (el: HTMLElement, i: number) => string
  /** 命中答案后的处理器：执行点击/输入 */
  handler: (
    type: QuestionTypes,
    answer: string,
    option: HTMLElement,          // 目标选项 DOM
    ctx: WorkContext<E>
  ) => void
}

/** 自定义工作器 */
type CustomWork<E> = (ctx: WorkContext<E>) => Promise<ResolverResult>

/** 查题器 */
type AnswererType<E> = (
  elements: SearchedElements<E, HTMLElement[]>,
  ctx: WorkContext<E>
) => SearchInformation[] | Promise<SearchInformation[]>
```

**元素选择器类型**

```ts
type ElementResolver<R> = (root: HTMLElement | Document) => R

type RawElements = Record<string | symbol,
  | string                                     // CSS 选择器
  | ElementResolver<(HTMLElement | null | undefined)[]>       // 解析函数（返回数组）
  | ElementResolver<HTMLElement | null | undefined>[]         // 函数数组
> & {
  title?: ...     // 题目元素（约定键）
  options?: ...   // 题目选项元素（约定键，默认工作器必须提供）
}

type SearchedElements<E, T> = Record<keyof E, T>  // 搜索结果，结构与 RawElements 对应
```

**上下文与结果**

```ts
interface WorkContext<E> {
  root: HTMLElement
  elements: SearchedElements<E, HTMLElement[]>
  searchInfos: SearchInformation[]
  type: QuestionTypes
  answerSeparators?: string[]
}

interface ResolverResult {
  finish: boolean
  [key: string]: any   // option/options/answers/ratings 等由各 resolver 附加
}

interface WorkResult<E> {
  requested: boolean    // 查题完毕
  searching?: boolean   // 搜题中（供面板转圈动画）
  resolved: boolean     // 答题完毕
  result?: ResolverResult
  error?: string
  ctx?: WorkContext<E>
}

/** 简化结果（存本地用，避免嵌套对象过大） */
interface SimplifyWorkResult {
  question: string
  type: QuestionTypes
  error?: string
  finish?: boolean
  requested: boolean
  searching?: boolean
  resolved: boolean
  searchInfos: { name; homepage?; error?; results: [string, string, object][] }[]
}

type QuestionTypes = 'single' | 'multiple' | 'completion' | 'judgement' | undefined
type WorkUploadType = 'save' | 'nomove' | 'force' | number

interface RootObserverOptions {
  enabled?: boolean          // 默认 false
  checkIntervalMs?: number   // 检测间隔，默认 1000ms
  lostTimeoutMs?: number     // 持续消失多久判定丢失（实现默认 1000ms）
  onRootLost?: () => void    // 丢失回调（关闭答题器之前触发）
}
```

---

### 2.3 CustomOCSWorker 自定义答题器

适用于无法用 DOM 元素描述的题目（自定义问答流）。

```ts
const worker = new CustomOCSWorker({
  period: number,             // 每题间隔 ms
  questions: () => ({ text: string; type: QuestionTypes }[] | Promise<...>),
  answerer: (question: string) => SearchInformation[] | Promise<SearchInformation[]>,
  resolver: (searchInfos: SearchInformation[]) => ResolverResult | Promise<ResolverResult>,
  onResultsUpdate?: (current: SimplifyWorkResult, index: number, results: SimplifyWorkResult[]) => void | Promise<void>
})

await worker.doWork()   // 逐题：搜题 → 作答 → 回调 onResultsUpdate
```

---

### 2.4 题型解析器（resolvers，纯函数）

文件：`packages/core/src/core/worker/resolvers/`

```ts
/** 创建默认的四题型处理器集合（worker 内部使用，也可直接使用） */
createDefaultQuestionResolver<E>(
  ctx: WorkContext<E>,
  optionText?: (el: HTMLElement, i: number) => string   // 默认 o.innerText
): Record<'single' | 'multiple' | 'completion' | 'judgement', QuestionResolver<E>>
```

#### 单选 resolveSingle

```ts
resolveSingle(answers: string[], options: string[], separators?: string[]): SingleResolveResult
// { finish, option?, ratings?, allAnswer?, options? }
```

四阶段自适应匹配：① 归一化精确匹配（去标点/全角差异）→ ② 相似匹配（相似度 > 0.6 的最高分选项）→ ③ 纯 ABCD 答案兜底（仅单字母，`charCodeAt(0) - 65` 映射选项下标）→ ④ 多片段答案合并重试（如 `"听党指挥 # 能打胜仗"` 拼接后重跑）。

#### 多选 resolveMultiple

```ts
resolveMultiple(resultAnswers: string[], options: string[], separators?: string[]): MultipleResolveResult
// { finish, options?, plainOptions?, groups? }

/** 领先度消歧：候选选项两两比较，文本相似(>0.6)时只保留匹配度更高的，解决"一字之差的选项全选" */
disambiguateSimilarOptions(options: string[], ratings: number[], threshold = 0.6): string[]
```

两阶段：① 归一化匹配（仅"答案⊇选项或相等"方向，避免 "TCP" 误选 "TCP/IP协议"）+ 相似匹配（带领先度消歧），按 `similarCount*100 + similarSum` 排序取最优组 → ② 纯 ABCD 兜底（`resolvePlainAnswer` 多字母映射）。

#### 判断 resolveJudgement

```ts
resolveJudgement(answerGroups: string[][], options: string[]): JudgementResolveResult
// { finish, option? }

/** 检测选项是否为判断题性质（仅两个选项且分别为对/错） */
isJudgementOptions(options: string[]): boolean
```

关键词：正确类 `['是','对','正确','确定','√','对的','是的','正确的','true','True','T','yes','1']`；错误类 `['非','否','错','错误','×','X','不对','不正确','false','False','F','no','0']`。

#### 填空 resolveCompletion

```ts
resolveCompletion(answerGroups: string[][], blankCount: number, separators?: string[]): CompletionResolveResult
// { finish, answers? }  answers 与填空框一一对应
```

逻辑：拆分后数量 === 空数直接采用；仅 1 个空时全部答案以空格合并；否则失败。

---

### 2.5 worker 工具函数

文件：`packages/core/src/core/worker/utils.ts`、`question.resolver.ts`

```ts
/** 默认题型推断：radio=2→judgement；radio>2→single；checkbox>2→multiple；textarea>=1→completion */
defaultWorkTypeResolver(ctx: WorkContext<any>): QuestionTypes | undefined

/** 答案是否为纯大写字母序列（如 "AB"、"ACD"），长度≤8、字符递增、不重复 */
isPlainAnswer(answer: string): boolean

/** 去除 [,，.。．、#] 等分隔后判断纯 ABCD 答案，返回清洗后的串或 undefined */
resolvePlainAnswer(answer: string): string | undefined

/** 检测答案是否为程序代码（评分制，命中 #include/main/printf/cout 等特征），是则拆分时保留 ; | ； */
isProgramAnswer(answer: string): boolean

/** 分割答案：JSON 数组 → 直接解析；否则按分隔符（默认 ['===','#','---','###','|',';','；']）拆分 */
splitAnswer(answer: string, separators?): string[]
```

---

### 2.6 题库配置 answer-wrapper

文件：`packages/core/src/core/answer-wrapper/`

#### 类型

```ts
/** 题库查询结果 */
interface SearchInformation {
  results: Result[]        // [{ question, answer, extra_data? }]
  name: string             // 题库名
  url?: string
  homepage?: string
  response?: any           // 原始响应
  data?: any               // 请求数据
  error?: string           // 错误信息
}

interface Result {
  question: string
  answer: string
  extra_data?: object
}

/** 题库配置器（用户在设置面板中配置） */
interface AnswererWrapper {
  url: string                                    // 请求地址
  name: string                                   // 题库名
  homepage?: string                              // 题库主页
  data?: Record<string, any>                     // 请求参数（支持 ${title} 等占位符）
  method: 'post' | 'get'                         // 默认 'get'
  contentType?: 'json' | 'text'                  // @deprecated 使用 responseType
  responseType?: 'json' | 'text'                 // 默认 'json'
  type: 'fetch' | 'GM_xmlhttpRequest'            // 请求模式（跨域用 GM）
  headers: Record<string, string>
  handler: string   // 响应解析器（字符串形式的方法体）：
                    // 'return (res)=> res.code === 0 ? undefined : [res.question, res.answer]'
                    // 返回 [题目, 答案, extra_data?] 或二维数组；undefined = 搜不到
}
```

#### AnswerWrapperParser（解析题库配置）

```ts
AnswerWrapperParser.fromObject(json: any): AnswererWrapper[]
AnswerWrapperParser.fromJSONString(json: string): AnswererWrapper[]
AnswerWrapperParser.fromBase64(base64: string): AnswererWrapper[]
AnswerWrapperParser.from(value: any): AnswererWrapper[]   // 自动识别上述三种来源
```

校验：必须是非空数组；每项 `name`/`url`/`handler` 必填；`method`/`type`/`contentType` 枚举校验。**安全限制**：已移除从 URL 远程加载题库配置的能力（防止"访问链接即注入代码"）。

#### defaultAnswerWrapperHandler（默认查题器）

```ts
const AnswerWrapperHandlerConfig = { timeout_seconds: 60 }   // 搜题超时（秒）

defaultAnswerWrapperHandler(
  answererWrappers: AnswererWrapper[],
  env: {
    title?: string           // 题目文本
    options?: string         // 选项文本
    type?: string            // 题型
    images?: string[]        // 图片题优化：base64 图片数组（对应 [图片1]、[图片2]…）
    suggestion_title?: string   // 图片 URL 替换为占位符后的标题
    suggestion_options?: string // 同上，选项
    [key: string]: any
  }
): Promise<SearchInformation[]>
```

行为要点：

- `data`/`url` 中的 `${xxx}` 占位符替换为 `env.xxx`（GET URL 侧自动 `encodeURIComponent`）。
- GET：`data` 追加为 query；POST：默认 `Content-Type: application/json`，`data` 字段支持 `{ handler: string }` 形式的字段解析器。
- `handler` 字符串经 `Function(handler)()` 生成解析函数。
- 多题库 `Promise.all` 并发，单题库失败不中断（记入 `error`）；与 `sleep(timeout_seconds * 1000)` 竞速超时。

---

## 3. @ocsjs/core — 工具库

### 3.1 DOM 搜索

文件：`packages/core/src/core/utils/dom.ts`

```ts
/** 元素搜索（返回单个元素或 null） */
domSearch<E extends RawElements>(wrapper: E, root: HTMLElement | Document = document): SearchedElements<E, HTMLElement | null>

/** 元素搜索（返回元素数组） */
domSearchAll<E extends RawElements>(wrapper: E, root?: HTMLElement | Document): SearchedElements<E, HTMLElement[]>

// 用法：每个键支持 选择器字符串 | 解析函数 | 函数数组
const { title, options } = domSearchAll({
  title: '.question-title',
  options: 'ul li.option'
}, document.body)
```

### 3.2 答案匹配算法

文件：`packages/core/src/core/utils/string.ts`（基于 `string-similarity`）

```ts
/** 删除特殊字符并转小写，只保留英文/数字/中文（额外保留 ①-⑨ 与 exclude 参数） */
clearString(str: string, ...exclude: string[]): string

/** 归一化：去中英文标点、空白、全角转半角后 clearString */
normalizeString(str: string): string

/** 归一化精确匹配：仅取"答案⊇选项或相等"方向，按等级（相等 > 包含）排序返回原始选项 */
answerNormalizedMatch(answers: string[], options: string[]): string[]

/** 相似度匹配：每选项对答案列表的最佳评分（Dice 系数，0~1） */
answerSimilar(answers: string[], options: string[]): Rating[]   // Rating = { target, rating }

/** 带领先度 gap 的相似度匹配：最高分选项与次高分的差距，解决"相似选项全选" */
answerSimilarWithGap(answers: string[], options: string[]): MatchRating[]  // MatchRating = Rating & { gap }

/** 精准匹配（trim 后全等） */
answerExactMatch(answers: string[], options: string[]): string[]

/** 剥离选项开头的冗余标签："A." / "A、" / "A选项"（仅字母后紧跟中文才剥离，不误删 "TCP协议"） */
removeRedundant(str: string): string
```

### 3.3 request 请求封装

文件：`packages/core/src/core/utils/request.ts`

```ts
request<T extends 'json' | 'text'>(url: string, opts: {
  type: 'fetch' | 'GM_xmlhttpRequest'   // GM 为油猴跨域请求
  method?: 'get' | 'post' | 'head'      // 默认 'get'
  responseType?: T                       // 默认 'json'
  headers?: Record<string, string>
  data?: Record<string, any>
  anyStatus?: boolean   // 任何 HTTP 状态码都 resolve { status, responseText }（状态探测用）
}): Promise<T extends 'json' ? any : string>
```

### 3.4 通用工具 $ 与 StringUtils

文件：`packages/core/src/utils/common.ts`、`string.ts`、`const.ts`

```ts
export const $ = {
  uuid(): string                                // 无横杠唯一 id
  random(min: number, max: number): number      // 随机整数
  sleep(period: number): Promise<void>          // 暂停 ms
  isInBrowser(): boolean
  elementToRawObject(el): { innerText, innerHTML, textContent }  // 跨域安全的纯文本化
  onresize(el, handler): void                   // 页面宽度变化（el 移除后自动解绑，debounce 200ms）
  isInTopWindow(): boolean                      // 是否顶级 window（非 iframe）
  createCenteredPopupWindow(url, winName, { width, height, scrollbars, resizable }): Window | null
  transition(el, properties, duration_ms, val, options?): Promise<void>  // CSS 过渡动画
}

export const $string = {
  humpToTarget(value: string, target: string): string   // 驼峰转分隔，如 innerHTML → inner-html
}

export class StringUtils {
  static of(text: string): StringUtils          // 链式入口
  static nowrap(str, replace_str): string       // 删换行符
  static nospace(str?): string                  // 多空格合一
  static noSpecialChar(str?): string            // 删特殊字符
  static max(str, len): string                  // 截断加省略号
  static hide(str, start, end, replacer = '*'): string
  // 对应实例方法可链式调用：StringUtils.of('A. B').nospace().noSpecialChar().toString()
}

export const $const = {
  TAB_UID: '_uid_',
  TAB_URLS: '_urls_',
  TAB_CURRENT_PANEL_NAME: '_current_panel_name_'
}
```

### 3.5 RemotePlaywright 远程浏览器控制

文件：`packages/core/src/utils/playwright.ts`

通过 OCS 桌面端（`http://localhost:15319`）以 Playwright CDP 控制真实浏览器，供智慧树/慕课等需要"真实点击"的平台使用。

```ts
RemotePlaywright.getRemotePage(
  show_debug_cursor?: boolean,     // 点击时显示红色圆圈鼠标指示
  logger?: (...args: any[]) => void
): Promise<RemotePage | undefined> // 单例；获取 token 失败返回 undefined
```

`RemotePage` 提供的方法（动作经桌面端后端转发执行）：

| 类别 | 方法 |
|---|---|
| 鼠标 | `click(selectorOrElement, options?)`（自动滚动定位/面板避让/坐标点击）、`mouse.click/dblclick/down/up/move/wheel` |
| 键盘 | `keyboard.type`、`keyboard.press`、`press`、`fill`、`focus` |
| 其他动作 | `check`、`dblclick`、`hover`、`tap`、`selectOption`、`setInputFiles`、`dragAndDrop`、`inputValue`、`bringToFront` |
| 等待 | `waitForSelector`、`waitForRequest`（返回 `{url, method, headers, postData}`）、`waitForResponse`（返回 `{body, headers, status, url}`） |
| 截图/刷新 | `screenshot`、`reload`（返回 base64） |

```ts
interface ClickOptions {   // 同 Playwright
  button?: 'left' | 'right' | 'middle'
  clickCount?: number
  delay?: number
  force?: boolean
  modifiers?: Array<'Alt' | 'Control' | 'Meta' | 'Shift'>
  position?: { x: number; y: number }
  timeout?: number
  trial?: boolean
  ...
}
```

安全措施：鼠标类动作前等待真实鼠标静止（200ms 无移动）；点击点被脚本面板遮挡时自动移开面板。

---

## 4. @ocsjs/utils — 用户脚本构建

文件：`packages/utils/src/common/script.builder.ts`（Node 端构建工具）

```ts
/** 组装并输出 .user.js 文件 */
createUserScript(opts: CreateOptions): Promise<void>
// CreateOptions = {
//   parseRequire: boolean, parseResource: boolean,
//   resourceBuilder: (key, value) => string,
//   metaDataFormatter: MetaDataFormatter,
//   entry: string,          // 入口 JS 路径
//   dist: string,           // 输出 .user.js 路径
//   metadata: Metadata
// }

/** 生成 ==UserScript== 头部信息块 */
createUserScriptMetadata(formatter: MetaDataFormatter, metadata: Metadata): string

/** 从 .user.js 提取 META 信息生成 .meta.js */
createMetaFile(opts: { dist: string; metaDist?: string }): Promise<void>

/** 下载/读取 @require 依赖并拼接 */
parseMetaDataRequires(require?: Metadata['require']): Promise<string>

/** 读取 @resource 资源并经 resourceBuilder 包装为 JS 变量 */
parseMetaDataResources(resource?: Metadata['resource'], resourceBuilder?): Promise<string>

/** 默认元数据 */
const DEFAULT_METADATA: Partial<Metadata> = {
  name: 'New Userscript', version: '0.1', description: 'try to take over the world!',
  author: ['You'], license: 'MIT', match: ['http://*/*'], grant: 'none', 'run-at': 'document-idle'
}

/** Metadata 字段：name/version/description/author/license/namespace/homepage/source/icon/
    connect/match/grant/require/resource/'run-at'（string | string[]） */
```

---

## 5. packages/scripts — 平台脚本包

### 5.1 脚本框架模型（easy-us）

```ts
import { Project, Script, start } from 'easy-us'   // 经 @ocsjs/scripts 转出口：start, $elements, $store

const project = Project.create({
  name: '平台名',
  domains: ['example.com'],          // 生效域名
  scripts: {
    study: new Script({
      name: '🖥️ 课程学习',
      namespace: 'xx.study',          // 配置存储命名空间
      matches: [                      // [描述, URL 字符串或正则][]
        ['课程学习页', '/study/learn'],
        ['旧版页面', /study\/v1/]
      ],
      configs: { playbackRate, volume, ... },   // easy-us Config 对象
      methods: (ctx) => ({ ... }),    // 脚本方法（内部通过 script.methods.xxx 调用）
      onstart() {},                   // 脚本启动即执行
      onactive() {},                  // URL 命中 matches 即触发
      oncomplete() {},                // 页面加载完成后触发
      onrender() {},                  // 渲染设置面板时
      onhistorychange(type) {},       // SPA 路由变化（push/replace/replaced）
      hideInPanel?: boolean,          // 隐藏面板
      priority?: number
    })
  }
})

start(definedProjects())   // definedProjects() 返回全部内置项目数组
```

### 5.2 commonWork 通用答题流程

文件：`packages/scripts/src/utils/work.ts` — 各平台作业/考试脚本的统一入口。

```ts
commonWork({
  mount_script?: Script        // 挂载面板的脚本；传入后立即置顶（子 iframe 中传 undefined）
  iframe_control?: boolean     // 子 iframe 操控条：顶层窗口渲染 暂停/继续/重新答题，经 cors 回传
  start_delay_seconds?: number // 自动答题倒计时（默认 5 秒，可点击取消）
  workerProvider: (opts: CommonWorkOptions) => Worker | undefined   // ★必填：worker 工厂
  beforeRunning?: () => void | Promise<void>      // 运行前钩子
  onRestart?: () => void | Promise<void>          // "重新答题"回调（内部先 emit('close')）
  onWorkerCreated?: (worker) => void | Promise<void>
}): void
```

配套导出：

```ts
/** 动态（逐题）答题提示："请勿手动切换题目" */
dynamicWorkTips(worker): void

/** 开始/重新答题/暂停-继续 三按钮组 */
createWorkerControl(options): { startBtn, restartBtn, controlBtn }

/** 结构化 DOM 遍历：提取文本与图片 URL（不读 innerText、跳过 display:none、detached 元素适用） */
extractTextWithImages(root, opts?): { text: string; images: string[] }

/** WorkResult → SimplifyWorkResult */
simplifyWorkResult(wr, titleTransform?, index?): SimplifyWorkResult

/** 动态答题结果 upsert（onQuestionDetected 与 onResultsUpdate 共用） */
updateDynamicResult(current, titleTransform?): void

/** 移除题目冗余词 */
removeRedundantWords(str: string, words: string[]): string
```

`CommonWorkOptions`（由全局设置生成，见 5.4）：

```ts
interface CommonWorkOptions {
  period: number                       // 搜题间隔（秒）
  thread: number                       // 答题线程
  upload: WorkUploadType               // 提交模式
  answererWrappers: AnswererWrapper[]  // 已过滤停用项的题库配置
  stopSecondWhenFinish: number
  redundanceWordsText: string          // 题目冗余词（多行文本）
  answerSeparators: string
}
```

### 5.3 createCommonAnswerer 搜题器工厂

```ts
createCommonAnswerer({
  /** 题目文本转换：返回 string 或 { text, images? }；text 为空抛错 */
  titleTransform: (elements, ctx) => string | { text: string; images?: string[] }
  /** 选项文本转换：不传则默认 options 元素 innerText 以 \n 拼接 */
  optionsTransform?: (elements, ctx) => string | { text: string; images?: string[] }
  answererWrappers: AnswererWrapper[]
  period?: number        // 搜题间隔秒，默认 3
}): (elements, ctx) => Promise<SearchInformation[]>
```

返回的 answerer 内部流程：本地题库缓存查询 → `buildAnswererEnv` 构造 env（含图片题优化）→ `defaultAnswerWrapperHandler` 搜题 → AI 答案中 `[图片N]` 占位符还原为图片 URL。

### 5.4 CommonProject 通用项目

文件：`packages/scripts/src/projects/common.ts`（domains 为空 = 全站生效）

**scripts.settings（全局设置）主要配置项**

| key | 默认 | 说明 |
|---|---|---|
| `answererWrappers` | `[]` | 题库配置（核心），支持一键获取/手动 JSON 粘贴/去重/风险检测 |
| `disabledAnswererWrapperNames` | `[]` | 停用的题库名单 |
| `upload` | `80` | 提交模式：save/nomove/10-100 提交率/force |
| `work-when-no-job` | `false` | 强制答题（无任务点也答，仅超星） |
| `randomWork-choice` | `false` | 搜不到答案时随机选择 |
| `randomWork-complete` | `false` | 搜不到答案时随机填空 |
| `randomWork-completeTexts-textarea` | `"不会,不知道,..."` | 随机填空文案 |
| `thread` | `1`（1-3） | 答题线程数 |
| `imageOptimize` | `true` | 图片题 Base64 优化 |
| `answerWrapperHandlerTimeout` | `120` 秒 | 搜题最大耗时 |
| `period` | `3` 秒 | 搜题间隔 |
| `answerSeparators` | `===,#,---,###,\|,;,；` | 答案分隔符 |
| `redundanceWordsText` | （19 行内置） | 题目冗余词删除 |
| `enableQuestionCaches` | `true` | 本地题库缓存 |

**关键方法**

```ts
// 生成各平台 workerProvider 使用的 CommonWorkOptions（深拷贝 + 过滤停用题库）
CommonProject.scripts.settings.methods.getWorkOptions(): CommonWorkOptions

// 按通知配置发系统通知
CommonProject.scripts.settings.methods.notificationBySetting(content, opts)
```

**scripts.workResults（搜索结果面板）**

```ts
CommonProject.scripts.workResults.methods.init({
  questionPositionSyncHandlerType?: 'cx' | 'zhs-gxk' | 'zhs-xnk' | 'zhs-smart' | 'zhs-fusion' | 'zhs-hike' | 'icve' | 'zjy' | 'icourse',
  dynamic?: boolean       // 动态（逐题）模式
})
CommonProject.scripts.workResults.methods.update(index, result)   // 整卷按序号更新
CommonProject.scripts.workResults.methods.fillAll(results)        // 整卷一次性填充
CommonProject.scripts.workResults.methods.append(result)          // 动态模式追加
CommonProject.scripts.workResults.methods.clearResults()
CommonProject.scripts.workResults.methods.getResults()
```

**CommonEvents（跨窗口事件）**：`emitAnswererChanged`（题库变更）、`emitWorkerChanged`（结果变更）、`emitWorkerStateChange('done'|'start'|'stop'|'close')`（worker 状态唯一入口）。

### 5.5 BackgroundProject 后台项目

文件：`packages/scripts/src/projects/background.ts`

| 脚本 | 说明 |
|---|---|
| `render` | 悬浮窗渲染：`methods.pin(script)` 置顶面板 / `normal()` / `minimize()` / `setPosition(x,y)` |
| `data` | 题库缓存：`addQuestionCache`（上限 200 去重）、`searchAnswerInCaches(title, whenSearchEmpty)`（缓存优先搜题）、`showQuestionCaches` |
| `console` | 日志面板；配套导出 `$console`（log/info/warn/error 写入日志配置，最多 50 条） |
| `dev` | 开发者调试：`methods.getRemotePlaywrightCurrentPage()` 获取桌面端 RemotePage；注入 `OCS_CONTEXT` |
| `update` | 版本检查 `getLastVersion()`、`showChangelog()` |
| `appConfigSync` | 连接 `http://localhost:15319/browser` 同步 OCS 桌面端配置 |
| `hack` / `disableDialog` / `edgeMinimize` / `requestList` / `errorHandle` / `environmentDetect` / `menus` | 解除复制限制、禁止弹窗、边缘最小化、请求记录、全局错误捕获、切屏检测、油猴菜单 |

### 5.6 各平台项目

#### 超星学习通（cx.ts，2450 行）

`CXProject` — domains：`chaoxing.com`、`edu.cn`、`org.cn`、`xueyinonline.com` 等 20+ 个（含各校专属域名）。

| 脚本 | 触发路由 | 功能 |
|---|---|---|
| `study` | `/knowledge/cards`、`/readsvr/book/mooc` | 课程学习主入口：视频（倍速/音量/人脸识别等待/弹题随机作答/进度条锁定）、PPT、阅读、章节测验（OCSWorker root `.TiMu`）、完成后按 `mode` 跳转 |
| `work` | `/mooc2/work/dowork`、`/mooc2/exam/preview` | 作业/考试（整卷预览模式，root `.questionLi`） |
| `mobilelearn` | `/page/quiz/stu/answerQuestion2` 等 | 随堂练习（root `.question-item`） |
| `examRedirect` | `exam/test/reVersionTestStartNew` | 考试：不允许整卷预览时逐题模式 |
| `autoRead` | `/ztnodedetailcontroller/visitnodedetail` 等 | 自动阅读翻页 |
| `rateHack` | `/ananas/modules/video/` | 屏蔽倍速限制 |
| `copyHack` | 全部 | 解除复制粘贴限制（劫持 UE 编辑器） |
| `cxSecretFontRecognize` | 作业/考试页 | 繁体密文字体识别（font-decrypt） |
| `studyDispatcher` | `/mycourse/studentstudy` | 章节调度（自动跳未完成任务点） |
| `versionRedirect` / `pageRedirect` / `env` / `guide` / `jfkGuide` | — | 版本切换/页面切换/跨域环境/提示 |

study 配置：`playbackRate`(1)、`volume`(0)、`videoQuizStrategy`(random/ignore)、`mode`(next下一节/job未完成任务/manually)、`restudy`、`autoJumpToUnFinishJob`(true)、`forceLearn`、`backToFirstWhenFinish`、`enableMedia/enablePPT/enableChapterTest/enableHyperlink`(均 true) 等。

题型映射：`input[id^="answertype"]` 值 0=单选 1=多选 3=判断 2/4-10=填空 11=连线 14=完形 15=阅读。

#### 知到智慧树（zhs.ts，3563 行，最大）

`ZHSProject` — domains：`zhihuishu.com`、`hike-teaching-center.polymas.com`。

核心抽象 `ZHSProcessor` 接口（`init/getCourseName/getChapterName/getNext/hideDialog/switchPlaybackRate/switchLine` 等），6 个实现：`StudyVideoH5`（共享课）、`FusionCourseH5`（AI 助教课）、`StudyPlusH5`（新共享课）、`WishdomH5`（新智慧共享课）、`Hike/HikeV2`（polymas AI 教学空间）。

| 脚本组 | 说明 |
|---|---|
| `study-center` / `work-center` | 设置中心（汇总配置，迁移旧命名空间） |
| `gxk-study` | 共享课学习：Processor + RemotePage 点击，视频播放（倍速上限 1.5x 防风控） |
| `gxk-work` | 共享课作业/考试：**拦截 `doHomework`/`doExam` 响应 JSON 获取题目**，逐题强制保存，易盾验证码挂起 |
| `smart-study` / `smart-work` / `smart-exam` | 新形态课程（fusioncourseh5 等 3 域名免桌面软件） |
| `xnk-study` / `xnk-work` | 校内课（翻转课） |
| `wisdom-study` | 新智慧学习（习惯分弹窗处理、黑屏重载上限 3 次） |
| `hike` / `hike_v2` / `hike-work` / `hike-homework` | polymas 教学空间 |

配置：`playbackRate`(1/1.25/1.5)、`volume`、`definition`(line1bq标清/line1gq高清)、`restudy`、`reloadWhenError`(true)、`stopTime`(定时停止)、`switchMode`(job只跳必学/all)、`workDelay`(3秒)、`studyRecord`(学习时长记录)。

#### 中国大学MOOC（icourse.ts）

`ICourseProject` — domains：`icourse163.org`。

- `dispatcher`：轮询 `location.hash` 分发到各脚本（`runAtHash` 配置匹配）。
- `study` / `study_v2`：按单元图标分派（video/pdf/discussion/quiz/text）；讨论区按策略回复（`discussionStrategy`: not-reply/random/最多点赞/最新）；需 RemotePage。
- `work`：`methods.start(type, canRun)`，type ∈ chapter-test/work/exam；所有点击经 `networkIdleRequire`（等网络空闲防 MOOC 并发限制）。
- 配置：`playbackRate`、`volume`、`readSpeed`(PPT 翻页 1-10 秒)、`enableChapterTest`(false)。

#### 智慧职教 icve（icve.ts）

`IcveMoocProject` — domains：`icve.com.cn`、`ai.icve.com.cn`、`courshare.cn`、`webtrn.cn`。

- `studyCenter`：课程列表页抓全部章节 URL，jwplayer 播放完自动下一章。
- `study`：`#mainContent` iframe 学习（视频/音频/文档），`switchPeriod`(10秒) 后切下一任务；弹窗测验自动选 `#right_answer`。
- `work`：`resetToBegin` 回第一题 → 动态逐题（root `.q_content`）。
- `ai-study` / `ai-work`：AI 课程（Vue 实例控制，倍速上限 16x）。

#### 雨课堂（yuketang.ts）

`YKTProject` — domains：`yuketang.cn`、`gdufemooc.cn`。

- `ai` 脚本（主学习）：视频（数字人视频/普通播放器，改 Vue player options）、讨论自动评论（`discussMode`: random/first/none）、作业任务点（`problemWork`）。
- **平台特有**：`exam_font_*.ttf` 动态密文字体，每题作答前 `FontDecryptor` 位图匹配解密；`runYktAnswerLoop` 逐题作答并**立即提交**（平台切题不保存）；`#homework-automation-risk-challenge` 风控验证码挂起。
- 配置：`restudy`、`problemWork`(true)、`discussMode`、`volume`、`playbackRate`(1-2x)。

#### 职教云（zjy.ts）

`ZJYProject` — domains：`icve.com.cn`、`zjy2.icve.com.cn`、`zyk.icve.com.cn`。

- `dispatcher`：Vue 路由分发（classroomNow 抓 `__vue__.activeList`）。
- `study`：按 `fileType` 分派（文档翻页 `vue.next()/skip()`、音视频播放），完成后 `vue.preNext` 或改 URL 跳转。
- `work`：`.subjectDet` 整卷答题，题型由 radio/checkbox/textarea 数量推断。

### 5.7 等待类工具与杂项工具

文件：`packages/scripts/src/utils/study.ts`、`index.ts`

```ts
/** 等待视频/音频加载（轮询 200ms，默认 3 分钟超时） */
waitForMedia(options?: {
  videoSelector?: string; audioSelector?: string; root?: HTMLElement | Document
  timeout?: number; filter?: (media) => boolean
}): Promise<HTMLVideoElement | HTMLAudioElement>

/** 等待元素出现（selector 为 CSS 字符串或返回元素的函数） */
waitForElement(selector, opts?: { timeout_seconds?; check_period_ms? }): Promise<HTMLElement | undefined>

/** 通用轮询等待：predicate 真值即 resolve；超时 resolve(undefined)（不 reject） */
waitFor<T>(predicate: () => T, opts?: { timeout_seconds?; check_period_ms? }): Promise<T | undefined>

/** 播放媒体（自动播放被拦截时弹 modal 引导点击） */
playMedia(playFunction: () => Promise<void> | void): Promise<boolean>

/** 解除复制限制 */
enableCopy(elements: (HTMLElement | Document)[]): void

/** 题目操作行：复制按钮 + 百度一下 */
createQuestionTitleExtra(question: string, ...left: HTMLElement[]): HTMLElement

/** 气泡消息 + 日志双输出 */
$msg.info / warn / error / success(attrs)
```

### 5.8 题库一键获取 answerer-connect

文件：`packages/scripts/src/utils/answerer-connect.ts`（postMessage 回传协议）

```ts
const ANSWERER_CONNECT_MESSAGE_TYPE = 'ocs-answerer-config'
const ANSWERER_CONNECT_PROTOCOL_VERSION = 1

interface AnswererConfigProvider {
  name: string        // 题库展示名
  connectUrl: string  // 题库站连接页（登录后向 opener 推送配置）
}

setAnswererConfigProvider(provider?: AnswererConfigProvider): void   // 入口脚本设置
getAnswererConfigProvider(): AnswererConfigProvider | undefined
openAnswererConnect(): Window | null    // 打开连接小窗（须在用户点击回调内同步调用）
waitForAnswererConfig(win: Window, timeoutMs = 10 * 60_000, isAborted?: () => boolean): Promise<AnswererWrapper[]>
// 三重来源校验（source/origin/协议版本），AnswerWrapperParser.from 解析
```

### 5.9 搜题环境与图片题优化 answerer-env

文件：`packages/scripts/src/utils/answerer-env.ts`

```ts
/** 构建 defaultAnswerWrapperHandler 的 env（核心） */
buildAnswererEnv(params: {
  type?: string; title: string; options?: string | string[]
  titleImages?: string[]; optionsImages?: string[]
  enableImageOptimize?: boolean
}): Promise<{ env: Record<string, any>; imageUrls: string[] }>

/** 图片题建议：URL 去重 → base64 → [图片N] 占位符文本 */
createImageSuggestion(title, options?, titleImages?, optionImages?): Promise<ImageSuggestionResult | undefined>
// ImageSuggestionResult = { images: string[]; urls: string[]; suggestion_title: string; suggestion_options?: string }

/** URL → base64（Canvas 优先绕防盗链，LRU 缓存 200） */
imageToBase64(source: string | HTMLImageElement): Promise<string>

const IMAGE_URL_REGEX: RegExp

/** 题库是否声明支持图片题优化（POST + 引用 ${images} 等占位符） */
isAnswererWrapperSupportImageOptimize(wrapper): boolean
isAnswererWrappersSupportImageOptimize(wrappers): boolean

/** 题库配置签名（FNV-1a 32bit），用于优化警告的关闭记录 */
createAnswererWrappersSignature(wrappers): string
```

### 5.10 题库安全检测

文件：`packages/scripts/src/utils/answer-wrapper-security.ts`

```ts
/** 检测 handler 代码段风险特征（eval/fetch/GM API/存储/全局对象等 21 种模式，启发式） */
detectHandlerRisks(code: string, where?: string): HandlerRiskFinding[]

/** 扫描题库配置所有可执行字段（aw.handler 与 aw.data.*.handler） */
scanAnswerWrapperRisks(aw: AnswererWrapper): HandlerRiskFinding[]

/** 风险弹窗确认；无风险或用户确认继续返回 true */
confirmRiskyAnswerWrappers(aws: AnswererWrapper[]): Promise<boolean>
```

### 5.11 UI 组件库

文件：`packages/scripts/src/utils/ui.ts`（样式前缀 `.aw-*`，与业务状态解耦）

```ts
const logoSvg: string            // OCS 图标 SVG
const loadingSpinSvg: string     // 加载旋转图标

createAccordionCard({ header, headerTrailing?, body, expanded?, className? }): HTMLElement
probeAnswerer(item: AnswererWrapper, disabled: boolean): Promise<AnswererProbeResult>
// HEAD 请求探测题库可达性（405/501 回退 GET，10 秒超时）
createAnswererWrapperList(aw: AnswererWrapper[], handlers: { isDisabled; onToggle }): HTMLElement[]
createAnswererWrapperSection(aw, title, handlers, withCopy = true): HTMLElement
createAnswererModeDropdown(): HTMLElement     // 官方/自定义题库获取方式下拉
createSteps(items: string[]): HTMLElement    // ①→②→③ 步骤指示器
createStatusBox(): { el; setStatus(text, 'info'|'success'|'error') }
createHero({ icon, title, subtitle, extra? }): HTMLElement

// render.ts / app.ts
const $render = { moveToEdge(x = 80, y = 100) }
const $playwright = { showError() }          // 提示需下载 OCS 桌面端
```

### 5.12 字体反解密 font-decrypt

文件：`packages/scripts/src/utils/font-decrypt/`（超星 cxsecret / 雨课堂动态字体共用的字形置换解密框架）

```ts
/** 动态解密器：同一字体映射表破解一次常驻内存，内容变化时增量破解 */
class FontDecryptor {
  static create(fontSource: string | ArrayBuffer, config: FontDecryptConfig): Promise<FontDecryptor>
  get size(): number                       // 已破解字符数
  decrypt(els: Element[]): Promise<void>   // 增量破解 + 解密元素
  waitForIdle(): Promise<void>             // 等待队列完成（答题读文本前调用）
}

interface FontDecryptConfig {
  refTableUrl: string      // 参考特征表（FRB2 位打包，按字重选择：cxsecret 350/400，可变字体 250）
  fontWeight?: string      // 可变字体必须设置，否则笔画粗细不一致匹配失败
  onProgress?: (done: number, total: number) => void
  useWorker?: boolean      // Web Worker 中破解（默认 true，不支持时回退主线程）
}

/** 破解加密字体 → { map: 密文字→真实字, details }（两级最近邻匹配：粗特征全表扫描 → 精特征） */
crackFont(fontSource, chars: string[] | string, config): Promise<CrackResult>

decryptText(text, map): string                     // 按映射解密文本
decryptElements(roots: Element | Element[], map)   // 原地解密文本节点（不碰结构）
collectChars(roots): string[]                      // 收集去重字符集
findFontUrls(doc?): string[]                       // @font-face + performance 记录找字体 URL
extractFontFromStyle(doc, fontFamilyMarker): ArrayBuffer | undefined  // 提取 base64 内嵌字体
listFontFaces(doc?): FontFaceInfo[]                // 列出全部 @font-face
loadRefTable(url): Promise<RefTable>               // 加载参考特征表（全局缓存）

/** 监听元素出现（MutationObserver + 防抖 + 防重入） */
watchElements(root, selector, onFound, options?: { debounceMs?: number }): WatchController
```

---

## 6. 使用示例

### 最小 OCSWorker 答题示例

```ts
import { OCSWorker, domSearchAll } from '@ocsjs/core'

const worker = new OCSWorker({
  // 题目根元素
  root: '.questionLi',
  elements: {
    title: '.question-title',
    options: '.question-option'      // 默认工作器必须提供
  },
  // 查题器
  answerer: async (elements) => {
    return defaultAnswerWrapperHandler(answererWrappers, {
      title: elements.title?.map((el) => el?.innerText).join('\n') ?? '',
      options: elements.options?.map((el) => el?.innerText).join('\n') ?? ''
    })
  },
  // 默认工作器
  work: {
    // type 不传则按 radio/checkbox/textarea 自动推断
    handler(type, answer, option) {
      if (type === 'single' || type === 'multiple' || type === 'judgement') {
        if (!option.querySelector('input')?.checked) option.click()
      } else if (type === 'completion') {
        const textarea = option.querySelector('textarea')
        if (textarea) textarea.value = answer
      }
    }
  },
  thread: 1,
  // 页面跳转（SPA hash 变化）后 root 消失时自动关闭
  rootObserver: { enabled: true },
  onResultsUpdate(result) { /* 更新结果面板 */ }
})

worker.on('done', () => console.log('答题结束'))

const results = await worker.doWork({ enable_debug: true })

worker.uploadHandler({
  results,
  type: 80,   // 完成率 ≥ 80% 才提交
  callback: async (rate, uploadable) => {
    if (uploadable) document.querySelector<HTMLElement>('#submit')?.click()
    else document.querySelector<HTMLElement>('#save')?.click()
  }
})
```

### 接入 commonWork 的平台脚本骨架

```ts
import { Project, Script } from 'easy-us'
import { commonWork, createCommonAnswerer } from './utils/work'
import { waitForElement } from './utils/study'
import { OCSWorker } from '@ocsjs/core'

export const MyProject = Project.create({
  name: '某某平台',
  domains: ['example.com'],
  scripts: {
    work: new Script({
      name: '✍️ 作业考试',
      namespace: 'my.work',
      matches: [['作业页', '/homework/do']],
      configs: {},
      methods: (ctx) => ({
        start: async () => {
          await waitForElement('.question-item')
          const commonOpts = CommonProject.scripts.settings.methods.getWorkOptions()
          const worker = new OCSWorker({
            root: '.question-item',
            elements: { title: '.q-title', options: '.q-option' },
            answerer: createCommonAnswerer({
              titleTransform: (els) => els.title?.map((e) => e?.innerText).join('') ?? '',
              answererWrappers: commonOpts.answererWrappers,
              period: commonOpts.period
            }),
            work: {
              handler(type, answer, option) {
                if (!option.querySelector('input')?.checked) option.click()
              }
            }
          })
          return worker
        }
      }),
      oncomplete() {
        commonWork({
          mount_script: this,
          workerProvider: (opts) => this.methods.start(opts)
        })
      }
    })
  }
})
```

---

## 附录：关键常量与默认值速查

| 常量 | 值 |
|---|---|
| 答案默认分隔符 | `['===', '#', '---', '###', '\|', ';', '；']` |
| 搜题超时 `AnswerWrapperHandlerConfig.timeout_seconds` | 60 秒 |
| 相似度阈值（单选/多选/消歧） | 0.6 |
| 搜题线程锁超时 | 3 分钟 |
| root 观察器 | `checkIntervalMs 1000`，`lostTimeoutMs 1000`（JSDoc 标称 3000） |
| 题库 wrapper 默认值 | name=`未知题库`、method=`get`、type=`fetch`、responseType=`json` |
| OCS 桌面端地址 | `http://localhost:15319` |
| 题库缓存上限 | 200 条 |
| 油猴 GM 请求 Content-Type | `application/x-www-form-urlencoded`（URLSearchParams 序列化） |

> 备注：① `WorkOptions.onAnswerSearched` 已声明但当前版本无触发点；② `AnswerMatchMode` 类型已导出但无引用（历史遗留）；③ 雨课堂/超星密文字体解密依赖 CDN 参考表 `font_ref_cx.bin` / `font_ref_yuketang.bin`。
