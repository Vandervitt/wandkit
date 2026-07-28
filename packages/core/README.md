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

### 4. 人工确认不计入超时预算

用户确认慢 → Run 超时失败 → 诱导重复提交，是这类系统最典型的事故链。Runtime 用 `pausedMs` 把等待确认的时长从超时预算里扣除。

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
  getPageContext: moduleId => adapters.get(moduleId, routeName)?.getContext() ?? null,
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
  maxRounds: 6,
  maxToolCalls: 12,
  runTimeoutMs: 60_000
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

## 不做什么

- 不解析 DOM、不模拟点击——那是执行引擎的事（可另接 [page-agent](https://github.com/alibaba/page-agent) 之类）
- 不调用模型、不管 Key
- 不提供聊天 UI

## 状态

`0.1.0`，从一套已在生产运行的 toB 后台 Copilot 中抽出。234 个单测覆盖调度、确认、页面协同与契约校验。

API 在 1.0 之前可能调整。

## License

MIT
