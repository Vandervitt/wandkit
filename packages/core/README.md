# toolairlock

> Nothing writes without passing through the airlock.

给 in-app LLM Agent 加上能上生产的安全带：**风险分级的工具契约、类型层面强制的两阶段写入、确认前的二次校验、权限过滤、写入不确定态建模、结构化审计与 eval**。

它**不是**又一个 Agent 框架——不解析 DOM、不调模型、不渲染 UI。它是 Agent 与真实写操作之间的那道闸：外门进来 → 舱内验证 → 内门才开。

## 为什么需要它

toB 系统上生产卡住的从来不是「模型能不能点对按钮」，而是：

- 误删了谁负责？
- 怎么证明用户批准过这次操作？
- 确认框弹出后的 10 秒里数据被别人改了，点确认还该不该执行？
- 请求发出去了但不知道成没成，怎么劝阻用户重复提交？

市面上的 in-app agent 方案基本把这些留给了接入方自觉。本包把它们下沉到类型系统和调度器里。

## 核心设计

### 1. 写操作跳不过确认——靠类型，不靠自觉

```ts
interface WriteToolDefinition<TInput, TPrepared, TOutput> {
  risk: 'write' | 'destructive'
  prepare(ctx, input: TInput): Promise<PreparedAction<TPrepared>>
  execute(ctx, prepared: TPrepared): Promise<ToolResult<TOutput>>
  //             ^^^^^^^^ 吃不到 TInput，因此不可能绕过 prepare 直接写库
}
```

风险分级 `read | write | destructive | navigation` 决定调度路径：`read` 静默执行，`write`/`destructive` 一律挂起等待人工确认。

### 2. 确认后重新 prepare，防 TOCTOU

用户点「确认」时，Runtime 会**重跑一次 `prepare()`** 并与确认卡片展示过的内容比对，不一致就拒绝执行：

> 操作目标或影响已发生变化，请重新发起操作并确认最新内容

绝大多数 HITL 实现是「确认框存个 payload，点确定就提交」——中间几十秒里数据变了照样写。

### 3. 写入不确定态是一等公民

```ts
writeState?: 'committed' | 'unknown'
```

请求已发出但结果未知时，返回的不是笼统的「失败」，而是明确的「勿重复提交」。写入已提交但页面刷新失败，与页面同步失败，是两条不同的话术。

### 4. 生命周期、任务结果与共享 Deadline 分层

`RunStatus` 只描述 Runtime 当前执行到哪个生命周期位置；终态 Snapshot 的
`TaskOutcome` 描述本轮如何结束。两者都不替宿主判断业务目标是否已经达成：

| `TaskOutcome.kind` | 对应终态 | 含义 |
|---|---|---|
| `completed` | `completed` | Runtime 正常收敛；**不等于业务成功** |
| `needs_input` | `completed` | 工具明确需要用户补充信息，模型已进入追问 |
| `cancelled` | `cancelled` | 用户调用 `stop()` 结束 Run |
| `timed_out` | `failed` | 共享主动处理预算耗尽 |
| `failed` | `failed` | 工具、限额或 Runtime 异常 |

稳定错误码包括 `RUN_DEADLINE_EXCEEDED`、`MAX_ROUNDS_REACHED`、
`MAX_TOOL_CALLS_REACHED`、`TOOL_FAILED` 和 `RUNTIME_FAILED`。程序控制流应读取
`outcome.kind` 与 `outcome.error.code`，不要解析展示文案。

`runTimeoutMs` 是整次 Run 的共享主动处理预算，不会在单个操作或轮次之间重置。它覆盖
`page_context`、`prompt_composition`、`model_call`、`write_preparation`、
`write_revalidation`、`route_navigation`、`page_adapter_wait`、`read_execution`、
`navigation_execution`、`write_execution` 和 `ui_effect`。愿意合作的依赖会收到
`AbortSignal`；即使依赖忽略 signal，Runtime 也会通过 Promise 竞争在剩余预算内返回。

人工确认等待期间 Deadline 会暂停，合法确认或拒绝后继续使用剩余预算。错误确认 ID
不会恢复计时。`outcome.error.retryable` 只表示宿主能否安全地自动重放整个任务，不代表
Runtime 会自动重试；一旦开始过写执行，后续失败或超时都不会标记为可安全重放。写执行
超时时继续保守返回 `writeState: 'unknown'`，已明确提交后的 UI effect 超时则保留
`writeState: 'committed'`。

Core 保持 interface-first：接入方可以只用本地确认 UI，也可以等待自己的 Gateway 或
Approval API，再调用 `confirm`、`cancel` 或 `stop`。本包不实现、绑定或要求任何具体的
Gateway/Approval HTTP API、鉴权方式或部署拓扑。

### 5. 取消是标记，不是文案

```ts
isCancelledResult(result)   // 读 result.cancelled，绝不比对 message 文本
```

「是否取消」参与控制流分支（取消不算工具失败、不终止 Run）。一旦与展示文案耦合，改一句话就会静默改变执行语义。

## 安装

```bash
npm i toolairlock
```

`@sinclair/typebox` 是 peer dependency。

## 最小接入

```ts
import {
  AgentRuntime, ActionRouter, NavigationCoordinator, PageAdapterRegistry,
  createToolRegistry, resolveCandidates, composePromptMessages,
  defineReadTool, defineWriteTool
} from 'toolairlock'

const queryUsers = defineReadTool({
  moduleId: 'user', name: 'query', version: 1, owner: 'user-team',
  lifecycle: { status: 'active' },
  title: '查询用户', description: '按条件查询用户列表',
  aliases: ['查用户'], permissions: ['user:list'],
  risk: 'read', executionMode: 'hybrid',
  schema: UserQuerySchema,
  execute: async (ctx, input) => ({ ok: true, message: '已查询', data: rows })
})

const deleteUser = defineWriteTool({
  moduleId: 'user', name: 'delete', version: 1, owner: 'user-team',
  lifecycle: { status: 'active' },
  title: '删除用户', description: '删除指定用户',
  aliases: ['删用户'], permissions: ['user:remove'],
  risk: 'destructive', executionMode: 'global',
  schema: UserDeleteSchema,
  // 只准备确认内容，绝不写库
  prepare: async (ctx, input) => ({
    title: '确认删除用户',
    rows: [{ label: '用户', value: await nameOf(input.id) }],
    impact: '删除后不可恢复',
    // 可选：卡片上唯一不可能撒谎的部分，会参与确认时的重跑比对
    rawRequest: { method: 'DELETE', url: `/api/users/${input.id}` },
    payload: { id: input.id }
  }),
  // 只有 Runtime 在用户点下确认后才会调到这里。收到的是 prepare 产出的 payload
  // 本身（不是整个 PreparedAction），因此这里根本拿不到模型给的原始 input。
  execute: async (ctx, prepared) => {
    await api.deleteUser(prepared.id)
    return { ok: true, message: '已删除', writeState: 'committed' }
  }
})

const registry = createToolRegistry([userModule], [queryUsers, deleteUser])

const runtime = new AgentRuntime({
  llm: { chat: (messages, tools, signal) => myBackend.chat(messages, tools, signal) },
  registry,
  resolveCandidates,
  composePrompt: composePromptMessages,
  actionRouter: new ActionRouter({ adapters, navigation, resolveRouteName }),
  getRouteName: () => router.currentRoute.name,
  getPermissions: () => store.permissions,
  getPageContext: (moduleId, signal) =>
    adapters.get(moduleId, routeName)?.getContext(signal) ?? null,
  emit: event => ui.handle(event)
})

await runtime.start('把张三这个用户删掉')
// → 不会直接删。UI 收到 confirmation 事件，用户点确认后才走 execute。
```

**LLM 的 Key 永远不进前端。** `llm.chat` 由你实现，指向自己的后端代理。

## 本地化与定制

```ts
new AgentRuntime(deps, {
  messages: { writeStateUnknown: 'Request sent, outcome unknown — do not retry.' },
  // 轮次与工具调用次数缺省不限制：多步页面任务动辄二十来步，次数上限只会
  // 在做到一半时把 Run 判死。兜底交给时长上限和用户的 stop()。
  maxRounds: 20,
  maxToolCalls: 40,
  runTimeoutMs: 600_000
})

createPromptComposer({ systemPrompt: MY_PROMPT, timeZone: 'Europe/Berlin' })
```

全部面向用户的话术见 `AirlockMessages`，逐条可覆盖。

## 测试工具

```ts
import { evaluateTrace, collectModuleContractIssues, FakeLlm } from 'toolairlock/testing'

// 断言 trace：选中了预期模块、调了预期工具、写操作确实进了确认流程、终态正确
evaluateTrace(evalCase, runtime.traces.get(runId))

// CI 里守住模块契约：每个模块至少一个工具、工具权限不得越出模块声明、
// Schema 必须禁止额外字段、必须声明 owner 与生命周期
collectModuleContractIssues({ modules, tools })
```

## 核心包不做什么

`toolairlock` 本身**只是闸门**：

- 不解析 DOM、不模拟点击
- 不调用模型、不管 Key
- 不渲染任何界面

这三条对核心包永远成立——它是治理层，不是框架。

## 生态

需要上面那些能力时，装对应的独立包。它们都是可选的，**不装时核心包行为完全不变**。

| 包 | 提供什么 | 何时需要 |
|---|---|---|
| `@toolairlock/ui` | 确认卡片、交互遮罩 | 想直接用现成的确认界面 |
| `@toolairlock/chat` | 会话状态机（OpenAI 协议）+ 可选聊天面板 | 需要对话界面 |
| `@toolairlock/executor` | 通用 DOM 操作原语 | 想让 Agent 操作页面，而不必逐个声明业务工具 |
| `@toolairlock/interceptor` | 请求层拦截治理（默认拒绝 + 名单） | 想治理**未经声明**的写操作 |

### 两条治理路径

拆成独立包不是为了模块化好看，而是因为两条路径的**强度真的不同**，必须让接入方
看得见这个差别：

| | 路径 A：声明式工具（核心包） | 路径 B：请求层拦截（interceptor） |
|---|---|---|
| 强制力 | 类型层面——`execute` 拿不到 `TInput` | 运行时 |
| 确认时机 | 动作**之前** | 请求发出那一刻 |
| 确认前重跑比对（TOCTOU） | 有 | 无 |
| 披露 | 业务语义（「用户：张三」） | 原始 HTTP（可选 `describe()` 富化） |
| 覆盖面 | 仅已声明的工具 | 一切走网络的写 |

**纵深防御，不是二选一**：A 精确制导，B 兜底渔网。B 的存在让 A 的覆盖缺口不再致命
——宿主自有代码、以及 Agent 用 DOM 原语做的任何事，都在 B 的射程内。

`@toolairlock/executor` 的 DOM 原语正是需要 B 的原因：它让 Agent 能做没声明过的事，
而那些事的风险无法在调用前预判，只能按真实发出的请求逐个定级。

## 状态

`0.1.0`，从一套已在生产运行的 toB 后台 Copilot 中抽出。核心包 210 个单测覆盖调度、确认、页面协同与契约校验；连同生态各包全仓 526 个。

API 在 1.0 之前可能调整。

## License

MIT
