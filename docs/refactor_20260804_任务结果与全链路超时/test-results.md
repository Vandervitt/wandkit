# P0-2 任务结果与全链路超时测试结果

> 分支：`refactor_20260804_任务结果与全链路超时`
> 日期：2026-08-04
> 环境：Node.js `v22.20.0`、npm `10.9.3`

## 1. 最终结论

| 验证层级 | 最终结果 |
|---|---|
| 静态契约核对 | 通过；TaskOutcome 单一定义、依赖方向、状态迁移入口和可选 signal 均符合设计 |
| 目标测试集 | 8 个文件、184 个用例全部通过 |
| 确定性页面评估 | 3 个用例全部通过 |
| 全仓测试 | 58 个文件、864 个用例全部通过 |
| TypeScript | Core、Chat、Executor、Interceptor、UI 与页面评估全部通过 |
| Build | 5 个 workspace 包全部构建成功 |

## 2. TDD 红—绿证据

| 场景 | 命令 | Exit | 关键结果 |
|---|---|---:|---|
| Chat 优先读取结构化错误（RED） | `npx vitest run packages/chat/src/bridge.spec.ts -t '结构化 outcome'` | 1 | 预期“结构化超时文案”，实际为旧 `stopReason` |
| Chat 优先读取结构化错误（GREEN） | 同上 | 0 | 1 passed，21 skipped |
| 确定性跨包失败契约 | `npx vitest run packages/chat/src/runtimeContract.spec.ts -t '确定性终态契约'` | 0 | 1 passed，2 个非目标用例因 `-t` 过滤 |
| Chat 两文件回归 | `npx vitest run packages/chat/src/bridge.spec.ts packages/chat/src/runtimeContract.spec.ts` | 0 | 25 passed |
| abort 后仍调用排队 operation（RED） | `npx vitest run packages/core/src/runtime/runDeadline.spec.ts -t '尚未开始时 abort'` | 1 | 真实 operation 被调用 1 次 |
| abort 后仍提前标记 phase（RED） | 同上（加入第二条回归后） | 1 | 2 failed：operation 与 `onPhaseStart` 均被调用 |
| abort 排队竞态（GREEN） | 同上 | 0 | 2 passed，3 skipped |
| Deadline/Runtime/Router 回归 | `npx vitest run packages/core/src/runtime/runDeadline.spec.ts packages/core/src/runtime/agentRuntime.spec.ts packages/core/src/execution/actionRouter.spec.ts` | 0 | 134 passed |
| Trace outcome/status 不一致（RED） | `npx vitest run packages/core/src/runtime/traceCollector.spec.ts -t 'outcome 与终态 status'` | 1 | 畸形记录被错误恢复 |
| Trace 恢复回归（GREEN） | `npx vitest run packages/core/src/runtime/traceCollector.spec.ts` | 0 | 11 passed |
| 已 abort 的 waiter 返回已挂载 Adapter（RED） | `npx vitest run packages/core/src/execution/actionRouter.spec.ts -t '不返回已挂载 Adapter'` | 1 | Promise 错误 resolve Adapter |
| Adapter/ActionRouter 回归（GREEN） | `npx vitest run packages/core/src/execution/actionRouter.spec.ts` | 0 | 51 passed |
| 后置 Deadline phase 使用真实 5ms 总预算（RED） | 12 路并行执行 `agentRuntime.spec.ts -t '首次 prepare 忽略 signal'` | 3/12 失败 | 超时提前漂移到 `page_context`、`prompt_composition`、`model_call` |
| Deadline phase 确定性时钟（GREEN） | 同上 | 0/12 失败 | 等目标 operation 启动后推进 fake timer，12 路全部通过 |
| AgentRuntime 回归 | `npx vitest run packages/core/src/runtime/agentRuntime.spec.ts` | 0 | 79 passed |

前三组红灯均由目标能力缺失触发，不是测试夹具、类型配置或语法错误；最后一组红灯用于稳定复现测试自身的真实时钟竞争。生产逻辑未按个例打补丁，测试改为等目标 operation 确实启动后再推进共享 Deadline，修复后对应全文件测试重新通过。

## 3. 实施过程中的集成门槛

在最终自审修复前曾执行以下中间门槛，用于确认 Task 1–8 的集成状态；这些结果不替代后文的最终验证：

| 命令 | Exit | 结果 |
|---|---:|---|
| 8 文件目标测试集 | 0 | 180 passed |
| `npm run eval:page-agent` | 0 | 3 passed |
| `npm run verify` | 0 | 58 文件、860 用例通过；typecheck 与 build 通过 |

## 4. 最终静态契约核对

执行并确认：

```bash
git diff --check
test "$(rg -l '^export type TaskOutcome =' packages | wc -l | tr -d ' ')" = 1
rg -n '^export type TaskOutcome =' packages
if rg -n "runtime/runDeadline|\.\./runtime/runDeadline" \
  packages/core/src/execution packages/core/src/contracts \
  packages/core/src/runtime/promptComposer.ts packages/chat/src; then exit 1; fi
if rg -n -P "run\.status\s*=(?!=)" \
  packages/core/src/runtime/agentRuntime.ts; then exit 1; fi
```

结果均为 Exit 0：

- `TaskOutcome` 仅定义于 `packages/core/src/contracts/run.ts`。
- 执行层只依赖 `contracts/deadline.ts`，没有反向 import Runtime 实现。
- `AgentRuntime` 没有绕过状态机直接给 `run.status` 赋值。
- `getPageContext`、`formatContext`、`RouterPort.push`、`PageAdapter` 和 waiter 的 signal 均为可选参数。
- `git diff --check` 无空白或补丁格式问题。

## 5. 最终目标测试

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

- Exit：0
- Test Files：8 passed
- Tests：184 passed
- 未出现未处理 Promise rejection 或 fake timer 泄漏。

## 6. 确定性页面 Agent 评估

```bash
npm run eval:page-agent
```

- Exit：0
- Playwright：3 passed
- 覆盖旧 Runtime 十个网页任务基线、最终判据异常保留动作步骤、DOM 成功但 Runtime 随后失败的判定。
- 输出包含 `NO_COLOR` 被 `FORCE_COLOR` 覆盖的 Node 警告，不影响测试结果。
- 该结果是确定性页面评估，不冒充真实模型完成率。

## 7. 项目完整验证门槛

```bash
npm run verify
```

- 最终 Exit：0
- Vitest：58 个文件、864 个用例全部通过。
- Typecheck：`@toolairlock/chat`、`toolairlock`、`@toolairlock/executor`、`@toolairlock/interceptor`、`@toolairlock/ui` 与页面评估 tsconfig 全部通过。
- Build：上述 5 个 workspace 包全部由 `tsup` 成功产出 ESM、CJS 与 DTS。
- `packages/executor/src/tools.spec.ts` 有 3 条既有 jsdom `HTMLFormElement.requestSubmit()` 未实现提示；对应测试均通过，未新增失败。
