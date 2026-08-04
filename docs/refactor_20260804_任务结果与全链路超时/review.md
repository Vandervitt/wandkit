# P0-2 任务结果与全链路超时集成评审

> 分支：`refactor_20260804_任务结果与全链路超时`
> 日期：2026-08-04
> 评审范围：`95a3c13` 之后的生产代码、测试与公开文档改动

## 1. 评审结论

当前实现符合已批准设计，可以提交到当前开发分支。自审未留下 Critical 或 Important 未解决项；发现的三个竞态/校验问题均先通过失败回归稳定复现，再完成修复和全量验证。

## 2. 规格与架构核对

| 维度 | 状态 | 证据与结论 |
|---|---|---|
| 生命周期与任务结果分层 | 通过 | `RunStatus` 保留状态机职责；终态通过单一 `TaskOutcome` 判别联合表达五类结果；`completed` 明确不承诺业务成功 |
| 终态映射 | 通过 | Runtime 只由 `terminalStatus(outcome)` 派生终态；Trace 恢复同时校验 outcome 结构与 status 映射 |
| Deadline 依赖方向 | 通过 | 执行层只依赖 `contracts/deadline.ts` 的 `DeadlineScope`；`RunDeadline` 保持 Runtime 内部实现 |
| 全链路覆盖 | 通过 | 11 个 phase 覆盖页面上下文、Prompt、模型、两次 prepare、导航、Adapter、读/导航/写工具与 UI effect |
| 非合作依赖 | 通过 | `Promise.race` 保证忽略 signal 的 Promise 不会无限占住 Runtime；abort 竞争前后均清理 timer/listener |
| 确认暂停 | 通过 | 进入确认时 `pause()`，合法 ID 通过后才 `resume()`；错误 ID 不恢复预算 |
| first-wins | 通过 | `terminationCause` 在 abort 前写入；用户 stop 与 Deadline 后到事件均不能覆盖先发生原因 |
| 写入安全 | 通过 | 写执行超时为 `unknown` 且不可安全重放；明确 committed 后 UI effect 超时仍保留 committed |
| 工具协议完整性 | 通过 | 超时终止前补齐尚未完成的 `tool_call_id`，已经记录的调用不会重复追加 |
| 迟到结果 | 通过 | 终态、历史和页面请求不会被迟到 Promise 改写；停止后的写调用只发布保守 unknown，不采纳迟到成功 |
| Trace 与 Eval | 通过 | outcome 深拷贝持久化；旧 v1 Trace 可无 outcome；畸形/映射冲突记录被丢弃；Eval 可选校验 kind/code |
| Chat 兼容 | 通过 | 错误优先级为 outcome message → stopReason → 本地兜底；鸭子类型不引入 Core 硬依赖 |
| 向后兼容 | 通过 | 新 Snapshot 字段、Deadline、signal 与执行选项均为可选；旧 ActionRouter、Adapter、Router 和 Trace 仍可使用 |
| Gateway/Approval 边界 | 通过 | 只保留宿主控制接口；用户可选择本地 UI、自有 Gateway 或 Approval API，本分支未绑定具体网络实现 |

## 3. 自审发现与处理

| 严重度 | 位置 | 发现 | 处理与验证 |
|---|---|---|---|
| Important | `runtime/runDeadline.ts` | operation 排进微任务后若立刻 abort，真实操作仍会启动，`write_execution` 也会过早标记 | 在真实 operation 同一微任务内复查 signal，再调用 `onPhaseStart` 和 operation；2 条红灯转绿 |
| Important | `runtime/traceCollector.ts` | Trace 只校验 outcome 字段，不校验其与终态 status 的映射 | 增加映射校验；`completed + failed outcome` 回归由红转绿，旧无 outcome Trace 保持兼容 |
| Important | `execution/pageAdapterRegistry.ts` | signal 已 abort 且 Adapter 已挂载时，`waitFor` 会错误 resolve | 将 abort 检查前移到 mounted fast path 之前；回归由红转绿 |

## 4. 代码质量与生产就绪性

| 项目 | 结论 |
|---|---|
| 关注点分离 | 契约、预算器、Runtime 编排、执行层、Trace/Eval 和 Chat 投影职责清晰，没有循环依赖 |
| 类型安全 | 公开 outcome、timeout phase、write state 与 Eval 预期均有稳定类型；构建 DTS 成功 |
| 错误处理 | 程序控制流使用稳定 kind/code，不解析本地化 message；未知写入保持保守语义 |
| 资源清理 | Deadline timer、abort listener、Adapter waiter timer/listener 均覆盖成功、超时和 abort 路径 |
| 性能 | 未增加轮询或重复网络调用；每个阶段只增加常数级 timer/listener 与 Promise 竞争 |
| 安全与权限 | 未修改权限过滤和写确认边界；未增加外部 API、凭据、数据库或生产环境操作 |
| 文档 | Core/Chat README 已说明 outcome、Deadline、retryable、兼容优先级和可选 Gateway/Approval 接入 |

## 5. 遗留风险与非目标

- `AbortSignal` 和 Deadline 只能停止 Runtime 等待，不能撤销已经进入外部系统的副作用；`writeState: 'unknown'` 仍要求宿主提供人工核对路径。
- `retryable` 只是“自动重放是否安全”的结构化提示，不是自动重试授权；本分支没有实现幂等键、退避、任务队列或恢复。
- 业务成功仍需宿主判据、工具结果或 Eval 验证；`completed` 只表示 Runtime 正常收敛。
- Gateway/Approval API 的鉴权、幂等、审计与部署由接入方自行实现，本包只提供接入边界。
- P0-1 分支同样改动 Runtime 与 Chat，未来由用户合入时可能需要人工解决局部冲突；本分支未 cherry-pick、merge 或 push 其它分支。
- 页面评估为确定性基线；真实模型表现仍受模型、提示词和上游 Gateway 质量影响。

## 6. 最终判定

| 结论 | 状态 |
|---|---|
| Ready to commit | 是 |
| Ready to merge | 代码与验证层面是；按项目规则由用户手动处理合入 |
| 未解决 Critical | 0 |
| 未解决 Important | 0 |
| 已知测试警告 | 既有 jsdom `requestSubmit()` 提示，不影响 864 个用例通过 |
