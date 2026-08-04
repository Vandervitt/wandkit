# P0-2 任务结果与全链路超时 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Core Runtime 增加结构化 `TaskOutcome`，并用一份可暂停的总 Deadline 预算覆盖页面上下文、Prompt、LLM、prepare、工具执行、导航、Adapter 等待和 UI effect，同时保留写入 `committed` / `unknown` 的安全语义。

**Architecture:** 保留现有 `RunStatus` 状态机，在终态 Snapshot 上增加可选的判别联合 outcome。新建中立 `DeadlineScope` 契约和 Runtime 内部 `RunDeadline`，执行层通过可选 Scope 和 `AbortSignal` 合作式退出，Runtime 使用 Promise 竞争保证非合作依赖也不会无限挂起。

**Tech Stack:** TypeScript 5.4、Vitest 1.6 fake timers、npm workspaces、OpenAI-compatible tool calling protocol、Playwright 确定性页面评估。

---

设计事实源：[design.md](./design.md)

执行约束：

- 当前规则禁止使用子 Agent，因此使用 `superpowers:executing-plans` 在本会话内逐项执行。
- 修 bug 和新增纯逻辑均先建立失败回归，确认红灯原因后再改生产代码。
- 生产代码和测试在最终 `npm run verify` 与页面评估通过前不提交；最后按契约、执行链路、文档与验证记录分组提交。
- 每次 `git add` 和 `git commit` 前重新校验分支为 `refactor_20260804_任务结果与全链路超时`。
- 不 push、不 merge、不 cherry-pick P0-1 或安全修复分支。

## 文件职责锁定

| 文件 | 单一职责 |
|---|---|
| `packages/core/src/contracts/deadline.ts` | 公开 Deadline phase 词表与执行 Scope interface |
| `packages/core/src/runtime/runDeadline.ts` | 总预算、pause/resume、timer/abort/operation 竞争与 typed error |
| `packages/core/src/contracts/run.ts` | TaskOutcome、TaskTimeout、TaskFailure 和 Snapshot 形状 |
| `packages/core/src/runtime/agentRuntime.ts` | 运行编排、终止原因裁决、outcome 生成和 tool protocol 补齐 |
| `packages/core/src/execution/actionRouter.ts` | 工具、导航、UI effect 的 Deadline 传递与写入中止解释 |
| `packages/core/src/execution/navigationCoordinator.ts` | 路由 push 与 Adapter wait 的分阶段 Deadline |
| `packages/core/src/execution/pageAdapterRegistry.ts` | Adapter waiter 的挂载、超时、Abort 与资源清理 |
| `packages/core/src/runtime/promptComposer.ts` | 将 Runtime signal 透传到模块上下文格式化 |
| `packages/core/src/runtime/traceCollector.ts` | 存储和恢复 outcome / Deadline 元数据 |
| `packages/core/src/testing/evalSuite.ts` | 根据可选预期校验 outcome kind/code |
| `packages/chat/src/bridge.ts` | 将结构化 Runtime 失败投影为 Chat 可见错误 |

### Task 1：建立 Deadline 契约与可独立测试的预算器

**Files:**

- Create: `packages/core/src/contracts/deadline.ts`
- Create: `packages/core/src/runtime/runDeadline.ts`
- Create: `packages/core/src/runtime/runDeadline.spec.ts`
- Modify: `packages/core/src/index.ts`

- [x] **Step 1：写入 RunDeadline 的失败测试**

新建 `runDeadline.spec.ts`，用 fake timers 覆盖总预算、暂停、非合作 Promise 和外部 abort：

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RunDeadlinePhase } from '../contracts/deadline'
import {
  RunDeadline,
  RunDeadlineExceededError
} from './runDeadline'

function createDeadline(budgetMs = 100) {
  const controller = new AbortController()
  const timeouts: RunDeadlinePhase[] = []
  const deadline = new RunDeadline({
    budgetMs,
    startedAt: Date.now(),
    now: Date.now,
    controller,
    onTimeout: details => {
      timeouts.push(details.phase)
      return true
    }
  })
  return { controller, deadline, timeouts }
}

describe('RunDeadline', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('operation 忽略 signal 时仍在剩余总预算内超时', async() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const { deadline, timeouts } = createDeadline(100)
    const first = deadline.run('page_context', async() => 'ok')
    await expect(first).resolves.toBe('ok')
    vi.setSystemTime(60)
    const hanging = deadline.run('model_call', () => new Promise<never>(() => undefined))
    await vi.advanceTimersByTimeAsync(40)
    await expect(hanging).rejects.toBeInstanceOf(RunDeadlineExceededError)
    expect(timeouts).toEqual(['model_call'])
  })

  it('pause 期间不消耗预算', async() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const { deadline } = createDeadline(100)
    vi.setSystemTime(60)
    deadline.pause()
    vi.setSystemTime(1060)
    deadline.resume()
    expect(deadline.remainingMs()).toBe(40)
  })

  it('AbortSignal 先中止时立即退出且不记超时', async() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const { controller, deadline, timeouts } = createDeadline(100)
    const hanging = deadline.run('model_call', () => new Promise<never>(() => undefined))
    controller.abort(Object.assign(new Error('stopped'), { name: 'AbortError' }))
    await expect(hanging).rejects.toMatchObject({ name: 'AbortError' })
    expect(timeouts).toEqual([])
  })
})
```

- [x] **Step 2：运行新测试并确认红灯**

Run:

```bash
npx vitest run packages/core/src/runtime/runDeadline.spec.ts
```

Expected: FAIL；`contracts/deadline.ts` 和 `runtime/runDeadline.ts` 不存在，而不是测试夹具或 Vitest 配置错误。

- [x] **Step 3：实现 Deadline 契约**

`contracts/deadline.ts` 定义完整 phase 词表和 Scope：

```ts
export type RunDeadlinePhase =
  | 'page_context'
  | 'prompt_composition'
  | 'model_call'
  | 'write_preparation'
  | 'write_revalidation'
  | 'route_navigation'
  | 'page_adapter_wait'
  | 'read_execution'
  | 'navigation_execution'
  | 'write_execution'
  | 'ui_effect'

export interface DeadlineScope {
  run<T>(
    phase: RunDeadlinePhase,
    operation: () => T | Promise<T>
  ): Promise<T>
  remainingMs(): number
}
```

- [x] **Step 4：实现 RunDeadline**

`runDeadline.ts` 必须提供以下类型和行为：

```ts
import type { DeadlineScope, RunDeadlinePhase } from '../contracts/deadline'

export interface DeadlineExceededDetails {
  phase: RunDeadlinePhase
  budgetMs: number
  activeElapsedMs: number
}

export interface RunDeadlineOptions {
  budgetMs: number
  startedAt: number
  now: () => number
  controller: AbortController
  onTimeout(details: DeadlineExceededDetails): boolean
  onPhaseStart?(phase: RunDeadlinePhase): void
}

export class RunDeadlineExceededError extends Error {
  readonly code = 'RUN_DEADLINE_EXCEEDED'

  constructor(readonly details: DeadlineExceededDetails) {
    super(`Run deadline exceeded during ${details.phase}`)
    this.name = 'RunDeadlineExceededError'
  }
}

export class RunDeadline implements DeadlineScope {
  pause(): void
  resume(): void
  activeElapsedMs(): number
  remainingMs(): number
  run<T>(phase: RunDeadlinePhase, operation: () => T | Promise<T>): Promise<T>
}

export function isRunDeadlineExceededError(
  error: unknown
): error is RunDeadlineExceededError
```

`run()` 的实现顺序固定为：

1. signal 已 abort 时抛出 `signal.reason` 或名为 `AbortError` 的 Error。
2. `remainingMs() <= 0` 时在执行 operation 前生成 typed timeout。
3. 调用 `onPhaseStart(phase)`。
4. `Promise.race([operation, timeout, abort])`。
5. timeout 回调先调用 `onTimeout(details)`，返回 `true` 时才以 typed error 作为 reason abort controller。
6. `finally` 清理 timer 和 abort listener。
7. `budgetMs === Infinity` 时不创建 timer，仍与 abort 竞争。

- [x] **Step 5：导出 Deadline 类型并跑绿测试**

`packages/core/src/index.ts` 增加：

```ts
export type { DeadlineScope, RunDeadlinePhase } from './contracts/deadline'
```

Run:

```bash
npx vitest run packages/core/src/runtime/runDeadline.spec.ts
npm run typecheck --workspace=wandkit
```

Expected: RunDeadline 测试全部 PASS，Core typecheck 退出码为 0。

### Task 2：让 Prompt、导航和 Adapter 支持合作式中止

**Files:**

- Modify: `packages/core/src/contracts/module.ts`
- Modify: `packages/core/src/contracts/pageAdapter.ts`
- Modify: `packages/core/src/runtime/promptComposer.ts`
- Modify: `packages/core/src/runtime/promptComposer.spec.ts`
- Modify: `packages/core/src/execution/navigationCoordinator.ts`
- Modify: `packages/core/src/execution/pageAdapterRegistry.ts`
- Modify: `packages/core/src/execution/actionRouter.spec.ts`

- [x] **Step 1：为 Prompt signal 透传写失败测试**

在 `promptComposer.spec.ts` 增加：

```ts
it('将 Runtime AbortSignal 透传给模块上下文格式化', async() => {
  const controller = new AbortController()
  let receivedSignal: AbortSignal | undefined
  const module: ModuleDefinition<{ companyName: string }> = {
    ...gatewayModule,
    formatContext: (context, signal) => {
      receivedSignal = signal
      return `Current company: ${context.companyName}`
    }
  }

  await composePromptMessages({
    activeModules: [module],
    pageContext: { moduleId: 'gateway', value: { companyName: 'Acme' } },
    history: [],
    signal: controller.signal
  })

  expect(receivedSignal).toBe(controller.signal)
})
```

- [x] **Step 2：为 Adapter waiter Abort 清理写失败测试**

在 `actionRouter.spec.ts` 的 `PageAdapterRegistry` describe 中增加：

```ts
it('waitFor 在 signal abort 时立即移除 waiter', async() => {
  const controller = new AbortController()
  const registry = new PageAdapterRegistry()
  const waiting = registry.waitFor(
    'gateway', routeName, requestId, 5000, controller.signal
  )

  controller.abort(Object.assign(new Error('stopped'), { name: 'AbortError' }))

  await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
  const waiters = (registry as unknown as {
    waiters: Map<string, Set<unknown>>
  }).waiters
  expect(waiters.size).toBe(0)
})
```

- [x] **Step 3：运行两组测试并确认红灯**

Run:

```bash
npx vitest run \
  packages/core/src/runtime/promptComposer.spec.ts \
  packages/core/src/execution/actionRouter.spec.ts \
  -t 'AbortSignal|waitFor 在 signal abort'
```

Expected: FAIL；`ComposePromptOptions.signal`、`formatContext` 第二参数和 `waitFor` 的 signal 尚不存在。

- [x] **Step 4：扩展可选 signal 契约**

按以下精确签名修改：

```ts
// contracts/module.ts
formatContext(context: TContext, signal?: AbortSignal): string | Promise<string>

// contracts/pageAdapter.ts
getContext(signal?: AbortSignal): TContext | Promise<TContext>
applyUiEffect(
  effect: UiEffect,
  requestId: string,
  signal?: AbortSignal
): void | Promise<void>

// runtime/promptComposer.ts
export interface ComposePromptOptions extends PromptComposerConfig {
  activeModules: ModuleDefinition<any>[]
  pageContext?: { moduleId: string, value: unknown }
  history: readonly LlmMessage[]
  now?: Dayjs
  signal?: AbortSignal
}
```

`composePromptMessages` 调用：

```ts
const context = await module.formatContext(
  options.pageContext.value,
  options.signal
)
```

- [x] **Step 5：为 RouterPort 和 NavigationCoordinator 增加可选执行选项**

`navigationCoordinator.ts` 增加：

```ts
import type { DeadlineScope } from '../contracts/deadline'

export interface RouterPort {
  getCurrentRouteName(): string | undefined
  push(location: RouterLocation, signal?: AbortSignal): Promise<unknown>
}

export interface NavigateAndWaitOptions {
  signal?: AbortSignal
  deadline?: DeadlineScope
}
```

`navigateAndWait` 签名改为：

```ts
async navigateAndWait(
  moduleId: string,
  routeName: string,
  requestId: string,
  options: NavigateAndWaitOptions = {}
): Promise<PageAdapter>
```

内部使用私有 helper：

```ts
private runWithDeadline<T>(
  options: NavigateAndWaitOptions,
  phase: 'route_navigation' | 'page_adapter_wait',
  operation: () => T | Promise<T>
): Promise<T> {
  return options.deadline
    ? options.deadline.run(phase, operation)
    : Promise.resolve().then(operation)
}
```

`router.push` 使用 `route_navigation`，`adapters.waitFor` 使用 `page_adapter_wait`，两者都传入 `options.signal`。

- [x] **Step 6：实现 waitFor 的 Abort 资源清理**

`PageAdapterRegistry.waitFor` 签名增加第五个可选参数：

```ts
waitFor(
  moduleId: string,
  routeName: string,
  requestId: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<PageAdapter>
```

`AdapterWaiter` 增加 `removeAbortListener?: () => void`。完成、局部超时和 abort 三条路径都调用同一个 cleanup helper，清理 timer、signal listener 和 waiter map。signal 已经 aborted 时立即返回 rejected Promise，不注册 waiter。

- [x] **Step 7：运行针对性测试**

Run:

```bash
npx vitest run \
  packages/core/src/runtime/promptComposer.spec.ts \
  packages/core/src/execution/actionRouter.spec.ts
```

Expected: 两个文件全部 PASS，旧导航局部超时语义不变。

### Task 3：将 DeadlineScope 接入 ActionRouter 并保住写入语义

**Files:**

- Modify: `packages/core/src/execution/actionRouter.ts`
- Modify: `packages/core/src/execution/actionRouter.spec.ts`

- [x] **Step 1：为阶段传递与写入超时写失败测试**

在 `actionRouter.spec.ts` 增加一个只记录 phase 的 Scope：

```ts
function recordingDeadline(phases: string[]) {
  return {
    remainingMs: () => 1000,
    run: async<T>(phase: string, operation: () => T | Promise<T>) => {
      phases.push(phase)
      return operation()
    }
  }
}
```

新增阶段顺序用例：

```ts
it('按路由、Adapter、工具和 UI effect 顺序使用 Deadline phase', async() => {
  const phases: string[] = []
  const registry = new PageAdapterRegistry()
  const adapter = createAdapter()
  const routerPort = createRouterPort({
    push: vi.fn(async() => { registry.register(adapter) })
  })
  const tool = defineReadTool({
    moduleId: 'gateway', name: 'query-phases', version: 1,
    title: '查询', description: '查询', aliases: [], permissions: [],
    owner: 'test', lifecycle: { status: 'active' },
    risk: 'read', executionMode: 'page', schema: Type.Object({}),
    execute: async() => ({ ok: true, message: 'ok', uiEffect: showQueryEffect })
  })

  await createActionRouter(registry, routerPort).execute({
    tool,
    context,
    input: {},
    requestId,
    deadline: recordingDeadline(phases)
  })

  expect(phases).toEqual([
    'route_navigation',
    'page_adapter_wait',
    'read_execution',
    'ui_effect'
  ])
})
```

再新增两条超时语义用例：

```ts
it('write_execution 超时时返回写入结果未知', async() => {
  const controller = new AbortController()
  const deadline = {
    remainingMs: () => 1000,
    run: async<T>(phase: string, operation: () => T | Promise<T>) => {
      if (phase !== 'write_execution') return operation()
      controller.abort(new Error('deadline'))
      throw new Error('deadline')
    }
  }
  const tool = defineWriteTool({
    moduleId: 'gateway', name: 'update-timeout', version: 1,
    title: '更新', description: '更新', aliases: [], permissions: [],
    owner: 'test', lifecycle: { status: 'active' },
    risk: 'write', executionMode: 'global', schema: Type.Object({}),
    prepare: vi.fn(),
    execute: vi.fn(() => new Promise(() => undefined))
  })
  const prepared: PreparedAction = {
    title: '更新', rows: [], payload: { id: 1 }
  }

  await expect(createActionRouter(new PageAdapterRegistry()).execute({
    tool,
    context: { ...context, signal: controller.signal },
    input: {},
    prepared,
    requestId,
    deadline
  })).resolves.toEqual({
    ok: false,
    message: defaultMessages.writeStateUnknown,
    writeState: 'unknown'
  })
})

it('committed 写入的 ui_effect 超时不降级为 unknown', async() => {
  const controller = new AbortController()
  const registry = new PageAdapterRegistry()
  registry.register(createAdapter())
  const committed: ToolResult = {
    ok: true,
    message: 'saved',
    writeState: 'committed',
    uiEffect: showQueryEffect
  }
  const deadline = {
    remainingMs: () => 1000,
    run: async<T>(phase: string, operation: () => T | Promise<T>) => {
      if (phase !== 'ui_effect') return operation()
      controller.abort(new Error('deadline'))
      throw new Error('deadline')
    }
  }
  const tool = defineWriteTool({
    moduleId: 'gateway', name: 'update-committed', version: 1,
    title: '更新', description: '更新', aliases: [], permissions: [],
    owner: 'test', lifecycle: { status: 'active' },
    risk: 'write', executionMode: 'global', schema: Type.Object({}),
    prepare: vi.fn(), execute: vi.fn().mockResolvedValue(committed)
  })

  await expect(createActionRouter(registry).execute({
    tool,
    context: { ...context, signal: controller.signal },
    input: {},
    prepared: { title: '更新', rows: [], payload: { id: 1 } },
    requestId,
    deadline
  })).resolves.toEqual(committed)
})
```

- [x] **Step 2：运行新 ActionRouter 测试并确认红灯**

Run:

```bash
npx vitest run packages/core/src/execution/actionRouter.spec.ts \
  -t 'Deadline phase|write_execution|ui_effect'
```

Expected: FAIL；`ExecuteActionOptions.deadline` 不存在，导航和效果也未使用 Scope。

- [x] **Step 3：将 DeadlineScope 透传到所有 ActionRouter await**

`ExecuteActionOptions` 增加：

```ts
deadline?: DeadlineScope
```

`executeToolWithAbortSemantics` 调用工具前按 risk 选 phase：

```ts
const phase = options.tool.risk === 'write' || options.tool.risk === 'destructive'
  ? 'write_execution'
  : options.tool.risk === 'navigation'
    ? 'navigation_execution'
    : 'read_execution'
const result = await this.runWithDeadline(options, phase, () => this.executeTool(options))
```

`navigateAndWait` 同时传：

```ts
{
  signal: options.context.signal,
  deadline: options.deadline
}
```

`applyEffect` 使用 `ui_effect` phase，并调用：

```ts
adapter.applyUiEffect(
  result.uiEffect as UiEffect,
  options.requestId,
  options.context.signal
)
```

- [x] **Step 4：跑绿 ActionRouter 全文件测试**

Run:

```bash
npx vitest run packages/core/src/execution/actionRouter.spec.ts
```

Expected: PASS；原有中止、页面仲裁、局部导航超时和写入未知态用例全部保持绿色。

### Task 4：新增 TaskOutcome、Trace 持久化与 Eval 断言

**Files:**

- Modify: `packages/core/src/contracts/run.ts`
- Modify: `packages/core/src/runtime/traceCollector.ts`
- Modify: `packages/core/src/runtime/traceCollector.spec.ts`
- Modify: `packages/core/src/testing/evalSuite.ts`
- Modify: `packages/core/src/testing/evalSuite.spec.ts`
- Modify: `packages/core/src/index.ts`

- [x] **Step 1：为 Trace outcome 和旧数据恢复写失败测试**

在 `traceCollector.spec.ts` 增加：

```ts
it('持久化结构化 outcome 且返回深拷贝', () => {
  const storage = createStorage()
  const traces = new TraceCollector(100, storage)
  const outcome = {
    kind: 'timed_out' as const,
    error: {
      code: 'RUN_DEADLINE_EXCEEDED' as const,
      message: 'timeout',
      retryable: false,
      phase: 'write_execution' as const,
      budgetMs: 100,
      activeElapsedMs: 101,
      writeState: 'unknown' as const
    }
  }
  traces.start('run-1', 'trace-1', 'update')
  traces.finish('run-1', 'failed', 'timeout', outcome)

  const first = traces.recent()
  first[0].outcome = { kind: 'completed' }
  expect(traces.recent()[0].outcome).toEqual(outcome)
  expect(new TraceCollector(100, storage).recent()[0].outcome).toEqual(outcome)
})

it('继续恢复没有 outcome 的 v1 Trace', () => {
  const storage = createStorage({
    [DEFAULT_TRACE_STORAGE_KEY]: JSON.stringify([{
      runId: 'run-1', traceId: 'trace-1', inputSummary: '[redacted:length=1]',
      startedAt: 1, endedAt: 2, status: 'completed', events: []
    }])
  })
  expect(new TraceCollector(100, storage).recent()[0].outcome).toBeUndefined()
})
```

- [x] **Step 2：为 Eval outcome kind/code 写失败测试**

在 `evalSuite.spec.ts` 增加两条用例：

```ts
it('配置 expectedOutcome 时校验 kind 和 code', () => {
  const result = evaluateTrace({
    id: 'timeout', input: '查询', expectedModuleId: 'gateway',
    expectedToolNames: [], expectedStatus: 'failed',
    expectedOutcome: { kind: 'timed_out', code: 'RUN_DEADLINE_EXCEEDED' }
  }, createTrace({
    status: 'failed',
    outcome: {
      kind: 'failed',
      error: { code: 'TOOL_FAILED', message: 'failed', retryable: false }
    },
    events: [{ type: 'candidates', names: ['gateway'] }]
  }))
  expect(result.issues.map(issue => issue.code)).toEqual([
    'OUTCOME_KIND_MISMATCH',
    'OUTCOME_CODE_MISMATCH'
  ])
})

it('未配置 expectedOutcome 时不要求旧 Trace 带 outcome', () => {
  const result = evaluateTrace({
    id: 'legacy', input: '查询', expectedModuleId: 'gateway',
    expectedToolNames: [], expectedStatus: 'completed'
  }, createTrace({
    events: [{ type: 'candidates', names: ['gateway'] }]
  }))
  expect(result.passed).toBe(true)
})
```

- [x] **Step 3：运行 Trace/Eval 测试并确认红灯**

Run:

```bash
npx vitest run \
  packages/core/src/runtime/traceCollector.spec.ts \
  packages/core/src/testing/evalSuite.spec.ts
```

Expected: FAIL；TaskOutcome 类型、Trace outcome 和 `expectedOutcome` 尚不存在。

- [x] **Step 4：实现公开 TaskOutcome 契约**

在 `contracts/run.ts` 中实现以下完整判别联合：

```ts
export interface TaskOutcomeError {
  code: string
  message: string
  retryable: boolean
}

export interface TaskTimeout extends TaskOutcomeError {
  code: 'RUN_DEADLINE_EXCEEDED'
  phase: RunDeadlinePhase
  budgetMs: number
  activeElapsedMs: number
  writeState?: 'committed' | 'unknown'
}

export interface TaskFailure extends TaskOutcomeError {
  code: 'MAX_ROUNDS_REACHED' | 'MAX_TOOL_CALLS_REACHED' | 'TOOL_FAILED' | 'RUNTIME_FAILED'
  writeState?: 'committed' | 'unknown'
}

export type TaskOutcome =
  | { kind: 'completed' }
  | { kind: 'needs_input' }
  | { kind: 'cancelled', reason: 'user_stopped' }
  | { kind: 'timed_out', error: TaskTimeout }
  | { kind: 'failed', error: TaskFailure }
```

`RunSnapshot` 增加 `outcome?: TaskOutcome`。`index.ts` 导出 TaskOutcome、TaskTimeout、TaskFailure 和 TaskOutcomeError。

- [x] **Step 5：扩展 Trace 事件与持久化校验**

`TraceEvent` 增加：

```ts
phase?: RunDeadlinePhase
budgetMs?: number
activeElapsedMs?: number
retryable?: boolean
writeState?: 'committed' | 'unknown'
```

`RunTrace` 增加 `outcome?: TaskOutcome`，`finish` 增加第四个可选参数 `outcome?: TaskOutcome`。`isRunTrace` 需要验证 outcome 判别联合，同时继续接受 outcome 缺失的旧记录。

- [x] **Step 6：实现 Eval 的可选预期**

```ts
export interface ExpectedTaskOutcome {
  kind: TaskOutcome['kind']
  code?: string
}

export interface EvalCase {
  id: string
  input: string
  expectedModuleId: string
  expectedToolNames: string[]
  requireConfirmation?: boolean
  expectedStatus: Extract<RunStatus, 'completed' | 'failed' | 'cancelled'>
  expectedOutcome?: ExpectedTaskOutcome
}
```

`evaluateTrace` 在 `expectedOutcome` 存在时追加 `OUTCOME_KIND_MISMATCH` 和 `OUTCOME_CODE_MISMATCH`；不存在时不读 Trace outcome。

- [x] **Step 7：跑绿 Trace/Eval 测试**

Run:

```bash
npx vitest run \
  packages/core/src/runtime/traceCollector.spec.ts \
  packages/core/src/testing/evalSuite.spec.ts
```

Expected: PASS。

### Task 5：让 AgentRuntime 生成结构化终态

**Files:**

- Modify: `packages/core/src/runtime/agentRuntime.ts`
- Modify: `packages/core/src/runtime/agentRuntime.spec.ts`
- Modify: `packages/core/src/runtime/runFailureVisibility.spec.ts`

- [x] **Step 1：为五类 outcome 和深拷贝写失败测试**

在 `agentRuntime.spec.ts` 增加或精化断言：

```ts
it('正常收敛只表示 completed，不表示业务成功', async() => {
  const { runtime } = createRuntime(new FakeLlm([finalReply('已回答')]))
  await expect(runtime.start('查询')).resolves.toMatchObject({
    status: 'completed',
    outcome: { kind: 'completed' }
  })
})

it('工具明确缺用户信息时产生 needs_input', async() => {
  readExecute.mockResolvedValueOnce({
    ok: false,
    message: '请补充公司 ID。',
    needsUserInput: true
  })
  const { runtime } = createRuntime(new FakeLlm([
    toolReply({ id: 'need-input', name: 'gateway_query_v1', args: '{"keyword":"x"}' }),
    finalReply('请告诉我公司 ID。')
  ]))
  await expect(runtime.start('查询')).resolves.toMatchObject({
    status: 'completed',
    outcome: { kind: 'needs_input' }
  })
})

it('snapshot outcome 是深拷贝', async() => {
  const { runtime } = createRuntime(new FakeLlm([]), {}, { maxRounds: 0 })
  const first = await runtime.start('超过轮次')
  if (first.outcome?.kind === 'failed') first.outcome.error.message = 'tampered'
  expect(runtime.snapshot().outcome).toMatchObject({
    kind: 'failed',
    error: { code: 'MAX_ROUNDS_REACHED' }
  })
  expect(runtime.snapshot().outcome).not.toMatchObject({
    kind: 'failed',
    error: { message: 'tampered' }
  })
})
```

将现有的轮次、工具数上限、工具失败、未预期异常和 `stop()` 用例分别增加对 `MAX_ROUNDS_REACHED`、`MAX_TOOL_CALLS_REACHED`、`TOOL_FAILED`、`RUNTIME_FAILED` 和 `{ kind: 'cancelled', reason: 'user_stopped' }` 的断言。

- [x] **Step 2：运行 outcome 相关测试并确认红灯**

Run:

```bash
npx vitest run packages/core/src/runtime/agentRuntime.spec.ts \
  -t 'outcome|needs_input|completed|MAX_ROUNDS_REACHED|user_stopped'
```

Expected: FAIL；当前 Snapshot 没有 outcome，且 `needsUserInput` 路径仍只返回 status completed。

- [x] **Step 3：将 ActiveRun 与 finish 改为 outcome 驱动**

ActiveRun 增加：

```ts
outcome?: TaskOutcome
requiresUserInput: boolean
writeExecutionStarted: boolean
lastWriteState?: 'committed' | 'unknown'
terminationCause?:
  | { kind: 'user_stopped' }
  | { kind: 'deadline', details: DeadlineExceededDetails }
```

`finish` 改为接收 `TaskOutcome`，由 helper 派生 terminal status：

```ts
function terminalStatus(outcome: TaskOutcome): Extract<RunStatus, 'completed' | 'failed' | 'cancelled'> {
  if (outcome.kind === 'completed' || outcome.kind === 'needs_input') return 'completed'
  if (outcome.kind === 'cancelled') return 'cancelled'
  return 'failed'
}
```

`finish` 在迁移前写入 `run.outcome = deepClone(outcome)`，将 outcome 传给 Trace，使用 outcome error message 或 `stoppedByUser` 生成兼容 `stopReason`。

- [x] **Step 4：为失败路径生成稳定 code**

Run 内部失败不再使用 `kind: 'timeout' | ...` 和 message 组合控制流，而是构建：

```ts
interface RunFailure {
  code: TaskFailure['code']
  message: string
}
```

`failAfterToolFailure` 默认 `TOOL_FAILED`，工具数上限显式传 `MAX_TOOL_CALLS_REACHED`。`RUNTIME_FAILED` 的 `retryable` 仅在 `writeExecutionStarted === false` 时为 true，其它 TaskFailure 均为 false。

- [x] **Step 5：记录 needs_input 和写入状态**

`recordToolResult` 在 `result.needsUserInput` 时同时设置 `run.needsUserInput = true` 与 `run.requiresUserInput = true`，在 `result.writeState` 存在时记录 `run.lastWriteState`。最终 assistant 无 tool call 时：

```ts
return this.finish(run, run.requiresUserInput
  ? { kind: 'needs_input' }
  : { kind: 'completed' })
```

- [x] **Step 6：深拷贝 Snapshot 和 Runtime UI 事件**

`snapshot()`、`toSnapshot()`、`lastSnapshot` 更新和 `publishState()` 都通过 `deepClone`，非终态 Snapshot 不包含 outcome。`clear()` 恢复的 idle Snapshot 保持原形状。

- [x] **Step 7：运行 AgentRuntime 现有全文件测试**

Run:

```bash
npx vitest run \
  packages/core/src/runtime/agentRuntime.spec.ts \
  packages/core/src/runtime/runFailureVisibility.spec.ts \
  packages/core/src/runtime/runStateMachine.spec.ts
```

Expected: PASS；状态机迁移和终态可见文案无回归。

### Task 6：将 RunDeadline 接入 AgentRuntime 的非写边界

**Files:**

- Modify: `packages/core/src/runtime/agentRuntime.ts`
- Modify: `packages/core/src/runtime/agentRuntime.spec.ts`

- [x] **Step 1：扩展 Runtime 测试夹具以支持 DeadlineScope**

`createRuntime` 中的 fake ActionRouter `execute` 必须在收到 `options.deadline` 时使用 risk 对应 phase 执行原 fake，使测试替身与真实 ActionRouter 的契约一致：

```ts
const execute = vi.fn(async(options: {
  tool: ToolDefinition
  prepared?: PreparedAction
  deadline?: DeadlineScope
}) => {
  const operation = () => options.tool.risk === 'write'
    ? writeExecute({} as ToolExecutionContext, options.prepared?.payload)
    : readExecute({} as ToolExecutionContext, { keyword: '默认' })
  const phase = options.tool.risk === 'write'
    ? 'write_execution'
    : options.tool.risk === 'navigation'
      ? 'navigation_execution'
      : 'read_execution'
  return options.deadline
    ? options.deadline.run(phase, operation)
    : operation()
})
```

- [x] **Step 2：为各非写阶段写失败测试**

在 `agentRuntime.spec.ts` 增加共用断言：

```ts
function expectTimedOut(
  snapshot: Awaited<ReturnType<AgentRuntime['start']>>,
  expectedPhase: string
): void {
  expect(snapshot).toMatchObject({
    status: 'failed',
    outcome: {
      kind: 'timed_out',
      error: {
        code: 'RUN_DEADLINE_EXCEEDED',
        phase: expectedPhase,
        budgetMs: 5,
        retryable: true
      }
    }
  })
}
```

然后加入四条精确用例：

```ts
it('getPageContext 忽略 signal 时在 page_context 超时', async() => {
  const { runtime } = createRuntime(new FakeLlm([finalReply()]), {
    getPageContext: () => new Promise(() => undefined)
  }, { runTimeoutMs: 5 })
  expectTimedOut(await runtime.start('查询'), 'page_context')
})

it('composePrompt 忽略 signal 时在 prompt_composition 超时', async() => {
  const { runtime } = createRuntime(new FakeLlm([finalReply()]), {
    composePrompt: () => new Promise(() => undefined)
  }, { runTimeoutMs: 5 })
  expectTimedOut(await runtime.start('查询'), 'prompt_composition')
})

it('LLM 忽略 signal 时在 model_call 超时', async() => {
  const llm: LlmClient = {
    chat: () => new Promise(() => undefined)
  }
  const { runtime } = createRuntime(llm, {}, { runTimeoutMs: 5 })
  expectTimedOut(await runtime.start('查询'), 'model_call')
})

it('读工具忽略 signal 时在 read_execution 超时', async() => {
  readExecute.mockImplementationOnce(() => new Promise(() => undefined))
  const { runtime } = createRuntime(new FakeLlm([
    toolReply({ id: 'read-timeout', name: 'gateway_query_v1', args: '{"keyword":"x"}' })
  ]), {}, { runTimeoutMs: 5 })
  expectTimedOut(await runtime.start('查询'), 'read_execution')
})
```

每条用例还要断言 Trace 含与预期 phase 一致的 `deadline_exceeded` 事件，可在 `expectTimedOut` 外传入 `runtime.traces.recent().at(-1)` 完成。

单条 outcome 断言的目标形状是：

```ts
expect(snapshot).toMatchObject({
  status: 'failed',
  outcome: {
    kind: 'timed_out',
    error: {
      code: 'RUN_DEADLINE_EXCEEDED',
      phase: expectedPhase,
      budgetMs: 5,
      retryable: true
    }
  }
})
```

- [x] **Step 3：为 stop / timeout first-wins 和非合作依赖写失败测试**

加入：

```ts
it('stop 先发生时立即结束忽略 signal 的 LLM', async() => {
  let started: (() => void) | undefined
  const requestStarted = new Promise<void>(resolve => { started = resolve })
  const llm: LlmClient = {
    chat: () => {
      started?.()
      return new Promise(() => undefined)
    }
  }
  const { runtime } = createRuntime(llm, {}, { runTimeoutMs: 60000 })
  const running = runtime.start('停止')
  await requestStarted

  runtime.stop()

  await expect(running).resolves.toMatchObject({
    status: 'cancelled',
    outcome: { kind: 'cancelled', reason: 'user_stopped' }
  })
})

it('Deadline 已发生时 stop 不覆盖 timed_out', async() => {
  const llm: LlmClient = { chat: () => new Promise(() => undefined) }
  const { runtime } = createRuntime(llm, {}, { runTimeoutMs: 5 })
  const result = await runtime.start('超时')

  runtime.stop()

  expect(result.outcome).toMatchObject({ kind: 'timed_out' })
  expect(runtime.snapshot().outcome).toMatchObject({ kind: 'timed_out' })
})
```

LLM 忽略 signal 后 5ms 返回 timed_out 由上一步的 `model_call` 用例覆盖。

- [x] **Step 4：在 ActiveRun 上创建 RunDeadline 和 first-wins cause**

`start()` 为每个 Run 创建独立 controller 和 `RunDeadline`。`onTimeout` 只在 `run.terminationCause` 为空时写入 `{ kind: 'deadline', details }` 并返回 true。`onPhaseStart('write_execution')` 置位 `writeExecutionStarted`。

`stop()` 先尝试写入 `{ kind: 'user_stopped' }`，失败时立即返回；成功后再 abort、回滚历史并 finish cancelled。

- [x] **Step 5：用 DeadlineScope 替换 chatWithDeadline 和被动超时**

先将 `AgentRuntimeDependencies.getPageContext` 签名改为：

```ts
getPageContext(moduleId: string, signal?: AbortSignal): unknown | Promise<unknown>
```

按以下调用覆盖边界：

```ts
await run.deadline.run('page_context', () =>
  this.dependencies.getPageContext(module.id, run.abortController.signal))

await run.deadline.run('prompt_composition', () =>
  this.dependencies.composePrompt({
    activeModules: modules,
    pageContext,
    history: this.historyStore.messages,
    signal: run.abortController.signal
  }))

await run.deadline.run('model_call', () =>
  this.dependencies.llm.chat(messages, tools, run.abortController.signal))
```

删除 `chatWithDeadline`、`timedOut` 布尔值与 `limitReason` 中的旧 timeout 分支。`limitReason` 保留轮次上限检查，每轮开头调用 `run.deadline.remainingMs()` 为 0 时通过 typed Deadline 路径结束。

- [x] **Step 6：实现 timeout outcome 和 Trace 记录**

新增 `finishTimedOut(run, writeState?)`，它从 first-wins details 构建：

```ts
{
  kind: 'timed_out',
  error: {
    code: 'RUN_DEADLINE_EXCEEDED',
    message: formatMessage(this.messages.runTimeout, { ms: this.runTimeoutMs }),
    retryable: !run.writeExecutionStarted,
    phase: details.phase,
    budgetMs: details.budgetMs,
    activeElapsedMs: details.activeElapsedMs,
    ...(writeState ? { writeState } : {})
  }
}
```

同时记录 `deadline_exceeded` Trace event。Runtime catch 只在 `terminationCause.kind === 'deadline'` 时走 timed_out；仅有 `user_stopped` 才走 cancelled，不再将所有 `AbortError` 都解释为用户停止。

- [x] **Step 7：接入读工具 ActionRouter Deadline**

`executeRead` 将 `deadline: run.deadline` 传给 ActionRouter。ActionRouter 因 Deadline abort 返回 cancelled 后，Runtime 先记录当前 tool result，再检查 typed termination cause 并进入 `finishTimedOut`，不得把它当成用户取消或普通工具失败。

- [x] **Step 8：运行非写 Deadline 测试**

Run:

```bash
npx vitest run packages/core/src/runtime/agentRuntime.spec.ts \
  -t 'page_context|prompt_composition|model_call|read_execution|first-wins|ignore signal'
```

Expected: PASS。

### Task 7：覆盖 prepare、确认暂停和写入超时

**Files:**

- Modify: `packages/core/src/runtime/agentRuntime.ts`
- Modify: `packages/core/src/runtime/agentRuntime.spec.ts`

- [x] **Step 1：为两次 prepare 和确认暂停写失败测试**

加入：

```ts
it('首次 prepare 忽略 signal 时在 write_preparation 超时', async() => {
  writePrepare.mockImplementationOnce(() => new Promise(() => undefined))
  const { runtime } = createRuntime(new FakeLlm([
    toolReply({ id: 'prepare-timeout', name: 'gateway_update_v1', args: '{"name":"x"}' })
  ]), {}, { runTimeoutMs: 5 })

  const snapshot = await runtime.start('更新')

  expectTimedOut(snapshot, 'write_preparation')
  expect(writeExecute).not.toHaveBeenCalled()
})

it('确认等待和错误 ID 都不消耗主动预算', async() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  writePrepare
    .mockResolvedValueOnce({ title: '更新', rows: [], payload: { id: 1 } })
    .mockResolvedValueOnce({ title: '更新', rows: [], payload: { id: 1 } })
  writeExecute.mockResolvedValueOnce({
    ok: true, message: 'saved', writeState: 'committed'
  })
  const { runtime } = createRuntime(new FakeLlm([
    toolReply({ id: 'paused-write', name: 'gateway_update_v1', args: '{"name":"x"}' }),
    finalReply('完成')
  ]), {}, { runTimeoutMs: 100 })
  const waiting = await runtime.start('更新')
  const confirmationId = runtime.currentConfirmation()?.confirmationId as string
  expect(waiting.status).toBe('awaiting_confirmation')

  vi.setSystemTime(60000)
  await expect(runtime.confirm('wrong-id')).rejects.toThrow()
  vi.setSystemTime(120000)
  await expect(runtime.confirm(confirmationId)).resolves.toMatchObject({
    status: 'completed', outcome: { kind: 'completed' }
  })
  vi.useRealTimers()
})

it('确认后第二次 prepare 在 write_revalidation 超时', async() => {
  writePrepare
    .mockResolvedValueOnce({ title: '更新', rows: [], payload: { id: 1 } })
    .mockImplementationOnce(() => new Promise(() => undefined))
  const { runtime } = createRuntime(new FakeLlm([
    toolReply({ id: 'revalidate-timeout', name: 'gateway_update_v1', args: '{"name":"x"}' })
  ]), {}, { runTimeoutMs: 5 })
  await runtime.start('更新')

  const snapshot = await runtime.confirm(
    runtime.currentConfirmation()?.confirmationId as string
  )

  expectTimedOut(snapshot, 'write_revalidation')
  expect(writeExecute).not.toHaveBeenCalled()
})
```

- [x] **Step 2：为写执行未知态写失败测试**

```ts
it('写执行忽略 signal 时按时返回 unknown 且禁止重试', async() => {
  writePrepare
    .mockResolvedValueOnce({ title: '更新', rows: [], payload: { id: 1 } })
    .mockResolvedValueOnce({ title: '更新', rows: [], payload: { id: 1 } })
  writeExecute.mockImplementationOnce(() => new Promise(() => undefined))
  const { runtime } = createRuntime(new FakeLlm([
    toolReply({ id: 'write-timeout', name: 'gateway_update_v1', args: '{"name":"x"}' })
  ]), {}, { runTimeoutMs: 5 })
  await runtime.start('更新')

  const snapshot = await runtime.confirm(
    runtime.currentConfirmation()?.confirmationId as string
  )

  expect(snapshot).toMatchObject({
    status: 'failed',
    outcome: {
      kind: 'timed_out',
      error: {
        phase: 'write_execution',
        retryable: false,
        writeState: 'unknown'
      }
    }
  })
  expect(runtime.history).toContainEqual(expect.objectContaining({
    role: 'tool',
    tool_call_id: 'write-timeout',
    content: expect.stringContaining('"writeState":"unknown"')
  }))
})
```

- [x] **Step 3：为已提交后 UI effect 超时写失败测试**

在 `agentRuntime.spec.ts` 从 `navigationCoordinator.ts` 导入 `NavigationCoordinator`，然后加入：

```ts
it('写入 committed 后 UI effect 超时保留已提交状态', async() => {
  let effectStarted: (() => void) | undefined
  const started = new Promise<void>(resolve => { effectStarted = resolve })
  const adapters = new PageAdapterRegistry()
  adapters.register({
    moduleId: 'gateway',
    routeName: 'Gateway-managemnet',
    getContext: () => ({}),
    applyUiEffect: () => {
      effectStarted?.()
      return new Promise(() => undefined)
    }
  })
  const navigation = new NavigationCoordinator({
    getCurrentRouteName: () => 'Gateway-managemnet',
    push: async() => undefined
  }, adapters)
  const actionRouter = new ActionRouter({
    adapters,
    navigation,
    resolveRouteName: () => 'Gateway-managemnet'
  })
  const committed: ToolResult = {
    ok: true,
    message: 'saved',
    writeState: 'committed',
    uiEffect: { type: 'gateway:refresh' }
  }
  writePrepare
    .mockResolvedValueOnce({ title: '更新', rows: [], payload: { id: 1 } })
    .mockResolvedValueOnce({ title: '更新', rows: [], payload: { id: 1 } })
  writeExecute.mockResolvedValueOnce(committed)
  const { runtime } = createRuntime(new FakeLlm([
    toolReply({ id: 'committed-effect-timeout', name: 'gateway_update_v1', args: '{"name":"x"}' })
  ]), { actionRouter }, { runTimeoutMs: 30 })
  await runtime.start('更新')

  const confirming = runtime.confirm(
    runtime.currentConfirmation()?.confirmationId as string
  )
  await started
  const snapshot = await confirming

  expect(snapshot).toMatchObject({
    status: 'failed',
    outcome: {
      kind: 'timed_out',
      error: {
        phase: 'ui_effect',
        retryable: false,
        writeState: 'committed'
      }
    }
  })
  expect(runtime.history).toContainEqual(expect.objectContaining({
    role: 'tool',
    tool_call_id: 'committed-effect-timeout',
    content: expect.stringContaining('"writeState":"committed"')
  }))
})
```

- [x] **Step 4：为多 tool call 的历史补齐写失败测试**

模型一次返回两个读调用，第一个执行超时。断言历史中两个 ID 均恰好出现一次：

```ts
const toolIds = runtime.history
  .filter(message => message.role === 'tool')
  .map(message => message.tool_call_id)
expect(toolIds).toEqual(['read-timeout', 'read-skipped'])
expect(new Set(toolIds).size).toBe(2)
```

当前调用写入 Run timeout 结果，后续调用补同一 `runTimeout` 文案且不向 UI 额外渲染 tool result。

- [x] **Step 5：将 Deadline 包住两次 prepare**

```ts
await run.deadline.run('write_preparation', () =>
  tool.prepare(this.createToolContext(run), input))

await run.deadline.run('write_revalidation', () =>
  tool.prepare(this.createToolContext(run), deepClone(pending.input)))
```

`ToolPreparationNotice` 和 `ToolPreparationError` 继续走原有语义；`RunDeadlineExceededError` 不得被归一成 `executionFailureResult`，必须返回 typed timeout 路径。

- [x] **Step 6：将 pause/resume 交给 RunDeadline**

`beginAwaiting` 调用 `run.deadline.pause()`，`endAwaiting` 调用 `run.deadline.resume()`。移除 ActiveRun 中旧 `pausedMs` / `awaitingSince` 字段与 `activeElapsed()`，保留“先验证 ID 再 resume”的调用顺序。

- [x] **Step 7：完成写 ActionRouter 超时结果的 Runtime 裁决**

`confirm` 将 `deadline: run.deadline` 传给 ActionRouter。ActionRouter 返回后先通过 `recordToolResult(..., { allowStoppedUi: true })` 保存真实 `unknown` / `committed`，然后若 typed termination cause 是 deadline，调用 `finishTimedOut(run, result.writeState ?? inferredWriteState)`。

- [x] **Step 8：实现 timeout 的 pending tool call 补齐**

新增一个私有 helper，只处理 `run.pendingToolCallIds` 中尚未追加结果的 ID：

```ts
private settlePendingCallsAfterTimeout(run: ActiveRun, currentResult?: ToolResult): void
```

当前 ID 尚在 pending 且提供了 `currentResult` 时，通过 `recordToolResult` 追加一次；其它 ID 直接向 ConversationStore 追加 `{ ok: false, message: formattedRunTimeout }`并从 pending 移除。已经移除的 ID 不重复追加。

- [x] **Step 9：运行 prepare/写入/协议完整性测试**

Run:

```bash
npx vitest run packages/core/src/runtime/agentRuntime.spec.ts \
  -t 'write_preparation|write_revalidation|pause|unknown|committed|tool_call_id'
```

Expected: PASS。

### Task 8：让 Chat bridge 消费结构化失败并更新公开文档

**Files:**

- Modify: `packages/chat/src/bridge.ts`
- Modify: `packages/chat/src/bridge.spec.ts`
- Modify: `packages/chat/src/runtimeContract.spec.ts`
- Modify: `packages/core/README.md`
- Modify: `packages/chat/README.md`

- [x] **Step 1：为 Chat 错误优先级写失败测试**

在 `bridge.spec.ts` 增加：

```ts
it('失败终态优先展示结构化 outcome 文案', () => {
  const { runtime, onEvent } = createRuntime()
  connectRuntime(session, runtime, { onEvent })

  runtime.emit({
    type: 'state',
    snapshot: {
      runId: 'r', traceId: 't', status: 'failed',
      outcome: {
        kind: 'timed_out',
        error: { message: '结构化超时文案' }
      }
    },
    stopReason: '旧文案'
  })

  expect(session.state.error).toBe('结构化超时文案')
})
```

保留现有“只有 stopReason”和“两者都没有”用例作为回退验证。

- [x] **Step 2：运行 Chat 测试并确认红灯**

Run:

```bash
npx vitest run packages/chat/src/bridge.spec.ts \
  -t '结构化 outcome'
```

Expected: FAIL；鸭子类型没有 outcome，失败分支仍优先 `stopReason`。

- [x] **Step 3：扩展鸭子类型并保留回退**

`RuntimeUiEventLike.snapshot` 增加最小结构：

```ts
outcome?: {
  kind: string
  error?: { message: string }
}
```

`applyRunStatus` 的 failed 分支使用：

```ts
session.fail(
  event.snapshot?.outcome?.error?.message
    || event.stopReason
    || messages.runFailed
)
```

- [x] **Step 4：在跨包契约中加入确定性 Runtime 失败**

`runtimeContract.spec.ts` 在现有真实模型 describe 之前新增：

```ts
describe('运行时与会话的确定性终态契约', () => {
  it('核心结构化失败无宿主补丁时仍对 Chat 可见', async() => {
    const { session, controls, events } = connect({
      llm: {
        chat: async() => { throw new Error('gateway unavailable') }
      }
    })

    await controls.send('查询线路')

    const terminal = events.filter(event =>
      event.type === 'state' && event.snapshot?.status === 'failed').at(-1)
    expect(terminal?.snapshot?.outcome).toMatchObject({
      kind: 'failed',
      error: { code: 'RUNTIME_FAILED' }
    })
    expect(session.state.status).toBe('idle')
    expect(session.state.error).toContain('gateway unavailable')
  })
})
```

现有真实模型 describe 继续 `skipIf`，不影响确定性契约测试。

- [x] **Step 5：更新 Core 和 Chat README**

Core README 增加：

- `RunStatus` 与 `TaskOutcome` 的分层解释。
- `completed` 不等于业务成功。
- 五类 outcome 及失败 code。
- Deadline 覆盖阶段、确认暂停和 `retryable` 安全语义。
- 外部 Gateway/Approval 等待可由宿主自行实现，Runtime 不绑定具体 API。

Chat README 更新失败文案优先级，并说明旧 Runtime 可继续只传 `stopReason`。

- [x] **Step 6：运行 Chat 与跨包契约测试**

Run:

```bash
npx vitest run \
  packages/chat/src/bridge.spec.ts \
  packages/chat/src/runtimeContract.spec.ts
```

Expected: 确定性测试 PASS；未配置真实模型时只跳过原有真实模型 describe。

### Task 9：集成核对、全量验证与交付记录

**Files:**

- Modify: `docs/refactor_20260804_任务结果与全链路超时/design.md`
- Modify: `docs/refactor_20260804_任务结果与全链路超时/plan.md`
- Create: `docs/refactor_20260804_任务结果与全链路超时/test-results.md`
- Create: `docs/refactor_20260804_任务结果与全链路超时/review.md`

- [x] **Step 1：运行集成契约核对**

逐项使用 `rg` 和 TypeScript 检查：

```bash
rg -n "outcome|RunDeadline|DeadlineScope|RunDeadlinePhase" \
  packages/core/src packages/chat/src
rg -n "getPageContext|formatContext|applyUiEffect|navigateAndWait|waitFor" \
  packages/core/src
rg -n "run\.status\s*=" packages/core/src/runtime/agentRuntime.ts
```

Expected:

- TaskOutcome 只有一份公开定义。
- 执行层只 import `contracts/deadline.ts`，不 import `runtime/runDeadline.ts`。
- 所有新 signal 都是可选参数。
- AgentRuntime 仍只能通过 `transitionRun` 改动 status。
- 终态 outcome 与 RunStatus 映射一致。

- [x] **Step 2：运行目标测试集**

Run:

```bash
npx vitest run \
  packages/core/src/runtime/runDeadline.spec.ts \
  packages/core/src/runtime/agentRuntime.spec.ts \
  packages/core/src/execution/actionRouter.spec.ts \
  packages/core/src/runtime/promptComposer.spec.ts \
  packages/core/src/runtime/traceCollector.spec.ts \
  packages/core/src/testing/evalSuite.spec.ts \
  packages/chat/src/bridge.spec.ts \
  packages/chat/src/runtimeContract.spec.ts
```

Expected: 目标文件全部 PASS，无未处理 Promise rejection，无 fake timer 泄漏。

- [x] **Step 3：运行确定性页面 Agent 评估**

Run:

```bash
npm run eval:page-agent
```

Expected: 命令退出码为 0；当前 `main` 的既有成功/失败基线不发生额外回归。不将该确定性结果冒充为真实模型完成率。

- [x] **Step 4：运行项目完整验证门槛**

Run:

```bash
npm run verify
```

Expected: Vitest 全仓测试、所有 workspace typecheck 和 build 全部退出 0。

- [x] **Step 5：完成集成自审**

检查实际 diff，重点核对：

- Runtime 每一个终态都有 outcome，没有某条早退路径仍直接传 status。
- Deadline typed error 不会被 `executionFailureResult` 或 navigation failure 错误归一。
- 写执行开始标记的时机不早于真正 `tool.execute`。
- `committed` 不会在页面效果超时后降级。
- pending tool call 只补一次，无重复 tool message。
- 迟到 Promise 不能重新发布 UI 或完成页面请求。
- Trace 恢复不接受畸形 outcome，但接受缺失 outcome 的旧记录。

- [x] **Step 6：写入真实测试与审查记录**

`test-results.md` 记录每条本轮实际执行命令、退出码、通过/失败数和关键输出；`review.md` 用表格记录契约对齐、写入安全、迟到结果、向后兼容与遗留风险。失败或未运行的命令必须原样记录，不得写成通过。

- [x] **Step 7：将设计状态和计划勾选更新为已实施**

`design.md` 顶部状态改为“已实施并通过项目验证”；`plan.md` 只勾选实际已完成的步骤。

- [x] **Step 8：最终验证后按逻辑分组提交**

每次 staging 前执行：

```bash
test "$(git branch --show-current)" = 'refactor_20260804_任务结果与全链路超时'
```

分组 1，契约、Deadline 基础、Trace 与 Eval：

```bash
git add \
  packages/core/src/contracts/deadline.ts \
  packages/core/src/contracts/run.ts \
  packages/core/src/runtime/runDeadline.ts \
  packages/core/src/runtime/runDeadline.spec.ts \
  packages/core/src/runtime/traceCollector.ts \
  packages/core/src/runtime/traceCollector.spec.ts \
  packages/core/src/testing/evalSuite.ts \
  packages/core/src/testing/evalSuite.spec.ts \
  packages/core/src/testing/index.ts \
  packages/core/src/index.ts
test "$(git branch --show-current)" = 'refactor_20260804_任务结果与全链路超时'
git commit -m 'refactor: 新增任务结果与共享 Deadline 契约'
```

分组 2，Runtime、ActionRouter、导航、Prompt 和 Chat 接入：

```bash
git add \
  packages/core/src/contracts/module.ts \
  packages/core/src/contracts/pageAdapter.ts \
  packages/core/src/runtime/promptComposer.ts \
  packages/core/src/runtime/promptComposer.spec.ts \
  packages/core/src/runtime/agentRuntime.ts \
  packages/core/src/runtime/agentRuntime.spec.ts \
  packages/core/src/runtime/runFailureVisibility.spec.ts \
  packages/core/src/execution/actionRouter.ts \
  packages/core/src/execution/actionRouter.spec.ts \
  packages/core/src/execution/navigationCoordinator.ts \
  packages/core/src/execution/pageAdapterRegistry.ts \
  packages/chat/src/bridge.ts \
  packages/chat/src/bridge.spec.ts \
  packages/chat/src/runtimeContract.spec.ts
test "$(git branch --show-current)" = 'refactor_20260804_任务结果与全链路超时'
git commit -m 'refactor: 接入全链路 Deadline 与写入安全结果'
```

分组 3，公开文档、测试结果与评审记录：

```bash
git add \
  packages/core/README.md \
  packages/chat/README.md \
  docs/refactor_20260804_任务结果与全链路超时/design.md \
  docs/refactor_20260804_任务结果与全链路超时/plan.md \
  docs/refactor_20260804_任务结果与全链路超时/test-results.md \
  docs/refactor_20260804_任务结果与全链路超时/review.md
test "$(git branch --show-current)" = 'refactor_20260804_任务结果与全链路超时'
git commit -m 'refactor: 记录全链路超时验证与评审结果'
```

- [x] **Step 9：提交后复核**

Run:

```bash
git branch --show-current
git status --short
git log -4 --oneline
```

Expected:

- 当前分支正确。
- 工作区干净。
- 最近提交包含设计、实施计划和三个最终逻辑提交。
- 本分支没有 push，没有 merge。
