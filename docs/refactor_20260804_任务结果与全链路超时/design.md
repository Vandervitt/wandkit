# P0-2 任务结果与全链路超时设计

> 分支：`refactor_20260804_任务结果与全链路超时`
> 日期：2026-08-04
> 状态：已实施并通过项目验证

## 1. 背景与目标

当前 Runtime 已具备权限过滤、两阶段写入、人工确认、TOCTOU 复核、写入不确定态和 Trace，但在任务结果表达与运行时限制上还有两个结构性缺口。

第一，`RunStatus` 只表示生命周期位置。`completed` 当前仅表示模型最终没有继续发起工具调用，它无法证明页面或业务目标已经达成。工具要求用户补充信息时，Runtime 也会在模型输出追问后进入 `completed`。宿主若只看 `status`，必须再解析展示文案、Trace 或 DOM 才能判断本轮真正如何结束。

第二，`runTimeoutMs` 当前只对 LLM 调用建立了定时器竞争。`getPageContext`、Prompt 组装、`module.formatContext`、两次 `prepare`、工具执行、路由跳转、Adapter 等待与 UI effect 都可以无限挂起。循环轮次之间的被动检查不能约束一个始终不返回的 Promise。

本阶段目标：

- 在不改变现有状态机的前提下，为终态 Snapshot 增加结构化 `TaskOutcome`。
- 明确 `completed` 只表示 Runtime 正常收敛，不承诺业务成功。
- 使所有可等待的边界共享同一份主动处理预算。
- 保留“人工确认等待不消耗预算”的现有安全性质。
- 即使宿主依赖忽略 `AbortSignal`，Runtime 也必须在 Deadline 内返回。
- 不破坏 `ActionRouter` 对写入 `committed` / `unknown` 的保守语义。

## 2. 设计原则

### 2.1 生命周期、任务结果与业务成功分层

```text
RunStatus：当前执行到哪个生命周期位置
TaskOutcome：本次 Run 以什么方式结束
业务成功：由宿主页面判据、工具结果或 Eval 验证
```

Runtime 不使用 `succeeded` 这类会暗示业务目标已验证的名称，也不通过解析模型最终回答推测成功。

### 2.2 主动中止与被动兜底同时存在

`AbortSignal` 负责让愿意合作的依赖及时释放资源；`Promise.race` 负责保证不合作的依赖无法无限占住 Runtime。两者不能互相替代。

### 2.3 写入采用保守结果

写请求已经发出但无法观测结果时，只能报 `unknown` 并禁止重试。工具已明确返回 `committed` 时，后续页面效果超时不得把已知提交状态降级为未知。

### 2.4 向后兼容

公开契约只增加可选字段或可选参数。旧宿主可继续只读 `status` 和 `stopReason`，旧 Trace 无需迁移，单独使用 `ActionRouter` 的接入也无需提供 Deadline。

## 3. 公开契约

### 3.1 TaskOutcome

```ts
export type TaskOutcome =
  | { kind: 'completed' }
  | { kind: 'needs_input' }
  | {
      kind: 'cancelled'
      reason: 'user_stopped'
    }
  | {
      kind: 'timed_out'
      error: TaskTimeout
    }
  | {
      kind: 'failed'
      error: TaskFailure
    }

export interface TaskOutcomeError {
  code: string
  message: string
  /** 宿主是否可以安全地自动重放整个任务。 */
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
  code:
    | 'MAX_ROUNDS_REACHED'
    | 'MAX_TOOL_CALLS_REACHED'
    | 'TOOL_FAILED'
    | 'RUNTIME_FAILED'
  writeState?: 'committed' | 'unknown'
}
```

`retryable` 只表示“自动重放是否安全”，不表示重放后一定成功，也不是 Runtime 自动重试的授权。映射规则为：

- `MAX_ROUNDS_REACHED`、`MAX_TOOL_CALLS_REACHED` 和 `TOOL_FAILED` 为确定性或需要人工处置的失败，`retryable: false`。
- `RUNTIME_FAILED` 只有在本 Run 从未开始写执行时才可标记 `retryable: true`。
- `timed_out` 只有在本 Run 从未开始写执行时才可标记 `retryable: true`。
- 一旦开始过写执行，本 Run 后续所有失败和超时均为 `retryable: false`。

### 3.2 RunSnapshot

```ts
export interface RunSnapshot extends RunState {
  runId: string
  traceId: string
  /** 新 Runtime 只在终态提供；可选是为了兼容旧 Runtime。 */
  outcome?: TaskOutcome
}
```

终态映射：

| `RunStatus` | `TaskOutcome.kind` | 解释 |
|---|---|---|
| `completed` | `completed` | Runtime 正常收敛，不保证业务成功 |
| `completed` | `needs_input` | 工具明确要求补充用户信息，模型已进入追问轮 |
| `cancelled` | `cancelled` | 用户调用 `stop()` 停止整个 Run |
| `failed` | `timed_out` | 主动处理预算耗尽 |
| `failed` | `failed` | 工具失败、轮次限额或 Runtime 异常 |

拒绝一张确认卡是工具级操作，不等于停止整个 Run。模型在收到拒绝结果后正常收敛，outcome 仍为 `completed`；这与“completed 不等于业务成功”的定义一致。

### 3.3 Deadline 契约

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

`DeadlineScope` 是中立契约，放在 `contracts/deadline.ts`。Runtime 实现放在 `runtime/runDeadline.ts`，执行层只依赖契约，不反向依赖 Runtime 内部。

## 4. 架构与组件边界

| 组件 | 职责 |
|---|---|
| `contracts/run.ts` | 定义 TaskOutcome、失败结构和 Snapshot 兼容契约 |
| `contracts/deadline.ts` | 定义阶段词表与执行层可依赖的 Deadline interface |
| `runtime/runDeadline.ts` | 管理总预算、确认暂停、定时器、Abort 竞争和类型化超时 |
| `runtime/agentRuntime.ts` | 组织各阶段，根据运行事实生成 outcome，补齐历史协议 |
| `execution/actionRouter.ts` | 将 Deadline 传入工具、导航和 UI effect，保留读写中止语义 |
| `execution/navigationCoordinator.ts` | 分别约束路由跳转和 Adapter 挂载等待 |
| `execution/pageAdapterRegistry.ts` | Abort 时立即清理 waiter 和局部定时器 |
| `runtime/traceCollector.ts` | 持久化结构化 outcome 和 Deadline 诊断事件 |
| `testing/evalSuite.ts` | 允许 Eval 可选断言结构化 outcome |
| `chat/bridge.ts` | 优先使用结构化失败文案，保留 `stopReason` 回退 |

本阶段不将 Gateway 或 Approval API 实现绑定到 Runtime。宿主可以在自己的 UI、Gateway 或审批服务中等待，最终调用 `confirm`、`cancel` 或 `stop`。未来若抽象 Approval Provider，也只提供 interface，由接入方选择是否实现以及如何部署。

## 5. Deadline 数据流与时序

### 5.1 全链路流程

```text
AgentRuntime.start / confirm
  → RunDeadline.run(phase, operation)
     ├─→ 真实操作先 settle
     │     → 清理 timer / abort listener
     │     → 返回正常结果
     ├─→ 用户 stop 先触发 AbortSignal
     │     → first-wins 记录 user_stopped
     │     → 立即抛 AbortError
     │     → cancelled outcome
     └─→ Deadline timer 先触发
           → first-wins 记录 typed timeout
           → abort 当前 Run
           → 立即抛 RunDeadlineExceededError
           → timed_out outcome
```

每次 `run()` 竞争真实操作、总预算定时器和 AbortSignal 中止事件。这样一来，用户 `stop()` 时即使依赖忽略 signal，在途 `start()` / `confirm()` Promise 也不会一直挂起到 Deadline。

### 5.2 总预算而非单操作超时

`RunDeadline` 保存 `startedAt`、`pausedMs` 和 `awaitingSince`。每个阶段的定时器使用：

```text
remaining = runTimeoutMs - activeElapsed
activeElapsed = now - startedAt - pausedMs - currentAwaitingDuration
```

新阶段不会重置预算。`remaining <= 0` 时在调用依赖之前直接超时。

### 5.3 确认暂停

```text
进入 awaiting_confirmation
  → deadline.pause()
  → 对外发布确认卡
  → 宿主本地确认 / Gateway / Approval API 等待
收到合法 approve/reject
  → deadline.resume()
  → 使用剩余主动处理预算继续
```

与现有实现一致，必须先验证 confirmation ID，再恢复计时。错误 ID 抛错后 Run 仍处于暂停状态。

### 5.4 阶段覆盖

| 异步边界 | Deadline phase | 合作式中止 |
|---|---|---|
| `getPageContext` | `page_context` | 传入 signal |
| `composePrompt` / `module.formatContext` | `prompt_composition` | `ComposePromptOptions.signal` |
| `llm.chat` | `model_call` | 已有 signal |
| 首次 `tool.prepare` | `write_preparation` | `ToolExecutionContext.signal` |
| 确认后二次 `prepare` | `write_revalidation` | `ToolExecutionContext.signal` |
| `router.push` | `route_navigation` | 可选 signal |
| `PageAdapterRegistry.waitFor` | `page_adapter_wait` | Abort 立即清理 waiter |
| 读工具 | `read_execution` | `ToolExecutionContext.signal` |
| 导航工具 | `navigation_execution` | `ToolExecutionContext.signal` |
| 写工具 | `write_execution` | `ToolExecutionContext.signal` |
| `adapter.applyUiEffect` | `ui_effect` | signal + requestId |

局部导航的现有 5 秒超时继续保留。它先触发时是普通导航失败；共享总预算先耗尽时才是 `timed_out`。

## 6. 中止信号的兼容扩展

以下公开 interface 增加可选 signal，已有实现可继续只接收原有参数：

```ts
getPageContext(moduleId: string, signal?: AbortSignal): unknown | Promise<unknown>

interface ComposePromptOptions {
  // existing fields...
  signal?: AbortSignal
}

interface ModuleDefinition<TContext> {
  formatContext(context: TContext, signal?: AbortSignal): string | Promise<string>
}

interface RouterPort {
  push(location: RouterLocation, signal?: AbortSignal): Promise<unknown>
}

interface PageAdapter<TContext> {
  getContext(signal?: AbortSignal): TContext | Promise<TContext>
  applyUiEffect(
    effect: UiEffect,
    requestId: string,
    signal?: AbortSignal
  ): void | Promise<void>
}
```

`ExecuteActionOptions` 增加可选 `deadline?: DeadlineScope`。Runtime 会传入共享 Scope，直接调用 `ActionRouter` 的宿主可以不传，行为与现在一致。

## 7. 终态与错误处理

### 7.1 first-wins 终止原因

Active Run 增加类型化 `terminationCause`。Deadline 必须先写入原因，再调用 `abort()`，避免同步 abort listener 把超时误判为用户停止。

```text
用户 stop 先发生  → cancelled
Deadline 先发生   → timed_out
后到事件           → 不得覆盖已有原因
```

### 7.2 needs_input

`needsUserInput` 继续负责下一轮隐藏工具，另增一个 Run 级别的事实标记，记录本轮曾经收到 `ToolResult.needsUserInput`。模型输出追问并无工具调用时，以 `needs_input` 而不是普通 `completed` 结束。

### 7.3 失败代码

| 当前路径 | `TaskFailure.code` |
|---|---|
| 轮次上限 | `MAX_ROUNDS_REACHED` |
| 工具调用数上限 | `MAX_TOOL_CALLS_REACHED` |
| 工具执行、校验或导航失败 | `TOOL_FAILED` |
| 未预期 Runtime 异常 | `RUNTIME_FAILED` |

展示文案继续使用宿主可覆盖的 messages，但代码与控制流完全不依赖 message。

### 7.4 深拷贝

`TaskOutcome` 是嵌套对象。`snapshot()`、Runtime UI 事件、Trace 读取和终态返回都必须深拷贝，避免宿主修改 `outcome.error` 后反向污染 Runtime 内部状态。

## 8. 写入安全矩阵

Runtime 在进入写工具 `execute` 之前置位 `writeExecutionStarted`。

| 超时位置 | 工具结果 | outcome `writeState` | `retryable` |
|---|---|---|---|
| 首次 prepare / 二次校验 | 未执行写入 | 无 | 无更早写入时为 `true` |
| 路由跳转 / Adapter 等待，写请求未发出 | 未执行写入 | 无 | 无更早写入时为 `true` |
| 写 `tool.execute` 正在执行 | `ok: false` | `unknown` | `false` |
| 写入明确提交，UI effect 超时 | 保留已知结果 | `committed` | `false` |
| 更早工具已经开始写，后续其它阶段超时 | 按当前阶段记录 | 可选 | `false` |

ActionRouter 继续作为写入中止语义的唯一权威：

- 读操作在 abort 后返回 `cancelled`，Runtime 根据 typed termination cause 将 Run 标记为 `timed_out` 或 `cancelled`。
- 写请求在执行期间 abort，未拿到明确结果时返回 `writeState: 'unknown'`。
- 已明确 `ok` 或 `writeState: 'committed'` 的结果继续保留，后续中止不得反转成未知。

## 9. 工具协议完整性

超时可能发生在 assistant 已经产生一组 `tool_calls` 之后。Runtime 在终止前必须为每个 ID 补齐且仅补一条 tool message：

- 当前执行中的读或导航工具：补结构化超时结果。
- 当前执行中的写工具：补 `unknown` 或已知 `committed` 结果。
- 同轮尚未开始的调用：补“因 Run 超时未执行”结果。
- 已经写入结果的 ID 不得重复 append。

这保证下一轮历史始终符合 OpenAI-compatible tool protocol。

## 10. 迟到结果与外部副作用

当依赖忽略 signal 时，Deadline 只能保证 Runtime 停止等待，不能撤销已经进入外部系统的请求。迟到结果必须满足：

- 不改变已发布的 outcome。
- 不重新迁移 Run 状态。
- 不追加会话消息，不覆盖已有 UI。
- 页面同步请求在 abort 时立即标记 `invalidated`。
- Adapter 同时获得 signal 与 requestId，应在真正应用效果前再检查。
- 写请求仍可能在迟到时提交，因此 `unknown` 不得被转化为可自动重试。

## 11. Trace、UI 与 Eval

### 11.1 Trace

`RunTrace` 增加可选 `outcome?: TaskOutcome`。Trace 存储 key 继续使用 v1，因为变更是可选字段的向后兼容扩展；恢复逻辑同时接受无 outcome 的旧记录。

超时时写入结构化事件：

```ts
{
  type: 'deadline_exceeded',
  phase,
  budgetMs,
  activeElapsedMs,
  retryable,
  writeState
}
```

不在 Trace 中记录原始业务 payload、用户输入或模型回答。

### 11.2 Runtime UI 事件与 Chat

终态 `state` 事件的 `snapshot` 携带 outcome。`stopReason` 继续保留作为旧宿主的展示字段。Chat bridge 的错误文案优先级为：

```text
snapshot.outcome.error.message
  → stopReason
  → Chat bridge 本地兜底
```

程序控制流使用 `outcome.kind` 和 `error.code`，不使用文案。

### 11.3 Eval

`EvalCase` 增加可选 `expectedOutcome`，旧用例不配置时只校验原有 `expectedStatus`。新断言使用稳定 code，不比较展示 message。

## 12. 改动文件

| 文件 | 操作 | 目的 |
|---|---|---|
| `packages/core/src/contracts/run.ts` | 修改 | 新增 TaskOutcome 与 Snapshot 契约 |
| `packages/core/src/contracts/deadline.ts` | 新建 | 定义 Deadline phase 和 Scope interface |
| `packages/core/src/contracts/module.ts` | 修改 | `formatContext` 支持可选 signal |
| `packages/core/src/contracts/pageAdapter.ts` | 修改 | 页面上下文与 UI effect 支持 signal |
| `packages/core/src/runtime/runDeadline.ts` | 新建 | 实现总预算、暂停和竞争 |
| `packages/core/src/runtime/agentRuntime.ts` | 修改 | 接入各阶段 Deadline 并生成 outcome |
| `packages/core/src/runtime/promptComposer.ts` | 修改 | 透传 signal |
| `packages/core/src/runtime/traceCollector.ts` | 修改 | 持久化 outcome 和 Deadline 事件 |
| `packages/core/src/execution/actionRouter.ts` | 修改 | 约束工具执行与 UI effect |
| `packages/core/src/execution/navigationCoordinator.ts` | 修改 | 约束路由与 Adapter 等待 |
| `packages/core/src/execution/pageAdapterRegistry.ts` | 修改 | Abort 时清理 waiter |
| `packages/core/src/testing/evalSuite.ts` | 修改 | 支持 expectedOutcome |
| `packages/core/src/index.ts` | 修改 | 导出新公开类型 |
| `packages/chat/src/bridge.ts` | 修改 | 优先消费结构化错误 |
| `packages/core/README.md` | 修改 | 说明 outcome、Deadline 和重试边界 |
| `packages/chat/README.md` | 修改 | 说明 Chat bridge 的兼容读取顺序 |
| 相关 `*.spec.ts` | 修改/新建 | 红绿回归与跨包契约验证 |

## 13. 测试策略

本任务改变公开结果契约和高风险写入中止语义，实施时对可单测逻辑使用 TDD。所有新测试先在当前实现上运行并确认因目标能力缺失而失败，再修改生产代码。

### 13.1 RunDeadline 单元测试

- 共享总预算不会在阶段间重置。
- pause / resume 正确扣除确认等待。
- 依赖忽略 signal 时 Deadline 仍按时 reject。
- `stop()` 触发的 abort 立即 reject，不等待总 Deadline。
- stop 与 timeout 两种先后顺序均守住 first-wins。
- 操作正常 settle 后清理 timer 和 listener。

### 13.2 AgentRuntime 集成测试

- `completed`、`needs_input`、`cancelled`、`timed_out`、`failed` 五类 outcome。
- page context、Prompt、LLM、两次 prepare、读执行和写执行卡死。
- 确认等待不消耗主动预算，错误 confirmation ID 不恢复计时。
- 写执行超时返回 `unknown` 且禁止重试。
- 一轮多工具时超时后每个 `tool_call_id` 都有对应结果。
- 迟到 resolve / reject 不改变 outcome、历史、Trace 或 UI。

### 13.3 ActionRouter 与页面同步测试

- 路由跳转、Adapter 等待、工具本体和 UI effect 使用正确 phase。
- Abort 立即移除 Adapter waiter 和局部定时器。
- 写执行超时保留 `unknown`。
- 已提交写入的 UI effect 超时保留 `committed`。
- 超时请求被标记 `invalidated`，迟到的页面结果不能重新标记 completed。

### 13.4 Trace、Eval 与 Chat 测试

- 新 outcome 可完整持久和恢复。
- 无 outcome 的 v1 Trace 仍可恢复。
- Eval 只在配置 `expectedOutcome` 时断言它。
- Chat bridge 优先结构化错误，旧 `stopReason` 与本地兜底继续工作。
- Core Runtime 与 Chat 的鸭子类型保持结构兼容。

### 13.5 验证命令

```bash
npx vitest run \
  packages/core/src/runtime/runDeadline.spec.ts \
  packages/core/src/runtime/agentRuntime.spec.ts \
  packages/core/src/execution/actionRouter.spec.ts \
  packages/core/src/runtime/traceCollector.spec.ts \
  packages/core/src/testing/evalSuite.spec.ts \
  packages/chat/src/bridge.spec.ts \
  packages/chat/src/runtimeContract.spec.ts

npm run eval:page-agent
npm run verify
```

本次不修改模型策略，也不依赖模型随机行为，因此不要求真实模型评估。确定性浏览器评估用于确认页面 Agent 链路无回归。

## 14. 验收标准

- 新 Runtime 所有终态 Snapshot 都包含与 `status` 匹配的 outcome，非终态不包含 outcome。
- `completed` 的公开文档明确不承诺业务成功。
- `needsUserInput` 路径结束时产生 `needs_input`。
- 页面上下文、Prompt、LLM、prepare、执行、导航、Adapter 等待和 UI effect 均受同一份主动处理预算约束。
- 确认等待时长不计入预算。
- 依赖忽略 signal 时，Runtime 仍在 Deadline 内返回。
- 用户 stop 与系统 timeout 永远产生不同 outcome，竞态由先发生者决定。
- 写执行超时返回 `writeState: 'unknown'` 且 `retryable: false`。
- 写入已提交后的 UI effect 超时保留 `writeState: 'committed'`。
- 超时后会话历史仍满足 tool call / tool result 一一配对。
- 迟到结果不能改变终态、Trace 或 UI。
- 旧 Snapshot 消费方、旧 Trace、旧 ActionRouter 调用和旧 Chat bridge 事件仍可使用。
- 目标单测、确定性页面评估和 `npm run verify` 全部通过。

## 15. 非目标

- 不实现自动重试、退避、任务队列或幂等键管理。
- 不实现 Run 持久化、恢复、断点续跑或跨页面重建确认。
- 不实现具体 Gateway、Approval API 或远程审批服务。
- 不在 Runtime 中加入业务成功 Verifier。
- 不修改数据库、权限模型、构建依赖或对外 HTTP API。
- 不在本分支合入 P0-1 或 `fast-uri` 安全修复，也不推送、不合并任何分支。

## 16. 兼容性与分支协作

P0-1 分支 `fix_20260804_网页Agent完成率缺口` 尚未合入 `main`，且同样修改 `agentRuntime.ts`、Chat bridge 与相关测试。本分支从最新 `main` 独立开发，通过新建 `contracts/deadline.ts` 与 `runtime/runDeadline.ts` 缩小 Runtime 内部改动，但后续合入两个分支时仍可能需要人工解决局部冲突。

本分支不尝试提前 cherry-pick 或合并 P0-1，避免未经用户决定改变分支交付边界。

## 17. 回滚边界

本改动无数据迁移和外部状态写入，可按以下逻辑组回滚：

1. TaskOutcome 契约、Trace 与 Chat 消费。
2. RunDeadline 和 AgentRuntime 全链路接入。
3. ActionRouter、NavigationCoordinator 和 PageAdapter 的合作式中止。

回滚新字段会让新宿主失去结构化 outcome，但旧 `status` / `stopReason` 路径仍可工作。
