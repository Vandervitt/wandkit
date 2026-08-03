# 网页任务完成率基线测试结果

> 分支：`test_20260802_网页任务完成率基线`
> 日期：2026-08-03
> 范围：Task 6 可选真实模型基线；Task 7 最终门禁尚未执行

## 1. 真实模型运行配置

真实模型只通过浏览器访问本地 OpenAI-compatible 代理，不读取或注入
`LLM_API_KEY`。

| 环境变量 | 缺省值 | 说明 |
| --- | --- | --- |
| `PAGE_AGENT_EVAL_REAL` | 未启用 | 只有值为 `1` 时运行真实模型基线 |
| `PAGE_AGENT_EVAL_REAL_ENDPOINT` | `http://127.0.0.1:8788/llm/chat` | 本地代理端点，只允许 HTTP/HTTPS 且禁止 URL 内嵌鉴权信息 |
| `PAGE_AGENT_EVAL_REAL_MODEL` | `LLM_MODEL` 或 `glm-4-flash` | 报告模型名，并随请求体传给兼容代理 |
| `PAGE_AGENT_EVAL_REAL_ATTEMPTS` | `3` | 每个场景重复次数，必须是正整数 |
| `PAGE_AGENT_EVAL_REAL_SCENARIOS` | 全部十个场景 | 逗号分隔的场景 ID；未知 ID 明确失败 |
| `PAGE_AGENT_EVAL_REAL_MAX_ROUNDS` | `20` | 单个 attempt 的模型轮次预算，必须是正整数；超限归类 `repeated_action` |
| `PLAYWRIGHT_OUTPUT_DIR` | `.playwright/网页任务完成率基线-20260802/` | 报告、原始交换和 Playwright 产物目录 |

运行命令：

```bash
npm run eval:page-agent          # 仍然只运行确定性基线
npm run eval:page-agent:real     # 自动设置 PAGE_AGENT_EVAL_REAL=1
```

## 2. TDD RED / GREEN 证据

### 2.1 OpenAI-compatible 客户端

先新增客户端测试，再运行：

```bash
npx vitest run evals/page-agent/site/openAICompatibleLlm.spec.ts
```

首次 RED：退出码 1，`Failed to resolve import "./openAICompatibleLlm"`。

实现后 GREEN：6 个测试通过，覆盖成功响应、HTTP 错误、结构错误、
`AbortSignal`、无鉴权头/Key 边界，以及轮次预算。

轮次预算回归测试首次 RED：预算为 2 时第 3 次请求仍然 resolve；修复后第 3
次请求在 fetch 前抛出稳定标记
`PAGE_AGENT_EVAL_REAL_MAX_ROUNDS_EXCEEDED`，fetch 和原始交换均保留前 2 轮。

### 2.2 Playwright 接线

真实 spec 创建后首次运行：

```bash
npx playwright test --config evals/page-agent/playwright.config.ts page-agent.real.eval.spec.ts
```

首次 RED：退出码 1，`No tests found`，证明 Playwright config 尚未接入 real spec。

接入 config 后启用单场景：

```bash
PAGE_AGENT_EVAL_REAL=1 \
PAGE_AGENT_EVAL_REAL_ATTEMPTS=1 \
PAGE_AGENT_EVAL_REAL_SCENARIOS=read-data \
npx playwright test --config evals/page-agent/playwright.config.ts page-agent.real.eval.spec.ts
```

第二次 RED：退出码 1，
`window.__WANDKIT_EVAL__.runLegacyReal is not a function`。

页面入口接通 `runLegacyRuntime({ llm })` 后，`read-data × 1` smoke 为
`1 passed (4.1s)`；报告结果为通过、1 step、1900 ms。

## 3. 失败路径门禁

| 场景 | 结果 |
| --- | --- |
| 未设置 `PAGE_AGENT_EVAL_REAL=1` | `1 skipped`；测试标题显示“设置 PAGE_AGENT_EVAL_REAL=1 后运行真实模型基线” |
| `PAGE_AGENT_EVAL_REAL_ATTEMPTS=0` | 退出码 1，提示必须是正整数 |
| `PAGE_AGENT_EVAL_REAL_MAX_ROUNDS=0` | 退出码 1，提示必须是正整数 |
| 场景过滤包含 `unknown-case` | 退出码 1，明确列出未知 ID |
| 代理端点指向不可达本地端口 | 退出码 1，显示 `OpenAI-compatible 代理请求失败: Failed to fetch` |
| 临时本地代理模拟 HTTP 502 / 上游 401 | 退出码 1，显示 `OpenAI-compatible 代理 HTTP 502: LLM 401: simulated invalid key`；临时服务随后已停止 |

上述代理错误均先写入 ignored `.playwright` 报告，再由 Playwright 断言失败，
不会 skip 或当作通过。

## 4. 30 分钟失败与根因修复

首次默认 `10 × 3` 全矩阵运行在 30 分钟处由 Playwright 自身超时，退出码 1：

```text
Test timeout of 1800000ms exceeded.
```

trace 显示前 21 个 attempts（到 `validation-recovery`）约 141.5 秒完成；
`async-loading` 前两次各运行约 10 分钟，第三次运行到总超时。模型不断以递增
索引调用 `page_click_v1`，工具反复返回“请先 capture 当前页面”，形成无界动作循环。

根因是旧 Runtime 默认单 Run 超时为 10 分钟且不限制模型轮次；三个 pathological
attempts 会耗尽 Playwright 30 分钟总预算。修复只作用于真实评估 LLM：每个 attempt
默认最多 20 个模型轮次，超限使用稳定错误标记并归类为 `repeated_action`，未修改生产
`AgentRuntime` 行为。

修复后的 `async-loading × 1`：

| 指标 | 结果 |
| --- | ---: |
| Playwright | `1 passed (30.3s)` |
| attempt 耗时 | 28517 ms |
| steps | 20 |
| failureCode | `repeated_action` |
| 原始交换 | 保留前 20 轮并写入 `.playwright` |

## 5. 最终真实模型全矩阵

命令：

```bash
npm run eval:page-agent:real
```

结果：退出码 0，`1 passed (3.3m)`。

报告：

- `.playwright/网页任务完成率基线-20260802/legacy-real-glm-4-flash-20260803T044608308Z-attempts.json`
- `.playwright/网页任务完成率基线-20260802/legacy-real-glm-4-flash-20260803T044608308Z-summary.md`
- `.playwright/网页任务完成率基线-20260802/legacy-real-glm-4-flash-20260803T044608308Z-exchanges.json`

总体结果：

| 指标 | 数值 |
| --- | ---: |
| 模型 | `glm-4-flash` |
| 场景数 | 10 |
| 每场景 attempts | 3 |
| 总 attempts | 30 |
| 通过 | 20 |
| 成功率 | 66.67% |
| 假成功率 | 0.00% |
| P50 / P95 steps | 3 / 6 |
| P50 / P95 耗时 | 5646 / 9802 ms |

分类结果：

| 类别 | 通过 / 总数 | 成功率 | 主要失败分类 |
| --- | ---: | ---: | --- |
| `read_data` | 3 / 3 | 100.00% | - |
| `navigation` | 3 / 3 | 100.00% | - |
| `search_filter` | 3 / 3 | 100.00% | - |
| `form` | 3 / 3 | 100.00% | - |
| `composite_select` | 3 / 3 | 100.00% | - |
| `rich_text` | 0 / 3 | 0.00% | `unsupported_control` |
| `validation_recovery` | 0 / 3 | 0.00% | `task_incomplete` |
| `async_loading` | 2 / 3 | 66.67% | 1 次 `repeated_action`（20 steps） |
| `ask_user` | 3 / 3 | 100.00% | - |
| `dynamic_dom` | 0 / 3 | 0.00% | `task_incomplete` |

## 6. 本任务验证

| 命令 | 结果 |
| --- | --- |
| `npx vitest run evals/page-agent/metrics.spec.ts evals/page-agent/report.spec.ts evals/page-agent/scenarios.spec.ts evals/page-agent/site/*.spec.ts` | 71 / 71 通过 |
| `npm run typecheck` | 各 workspace 与 page-agent tsconfig 均退出码 0 |
| `npm run eval:page-agent` | 2 / 2 通过，只运行确定性 spec |
| `npm run eval:page-agent:real` | 30 attempts 完成，Playwright 退出码 0 |

## 7. 已知限制

- 30 attempts 当前封装在一个 Playwright test 内，line reporter 不显示逐场景进度；失败
  时可从 trace 定位，但实时可观测性有限。
- 默认 20 轮是 eval-only 安全预算，防止模型循环耗尽总超时；确有更长任务时可通过
  `PAGE_AGENT_EVAL_REAL_MAX_ROUNDS` 显式覆盖。
- Task 7 会继续执行完整集成审查、最终门禁并补充本文件；本文件不提前声明 Task 7 完成。
