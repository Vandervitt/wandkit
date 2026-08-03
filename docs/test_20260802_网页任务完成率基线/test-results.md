# 网页任务完成率基线测试结果

> 分支：`test_20260802_网页任务完成率基线`
> 日期：2026-08-03
> 范围：Task 6 可选真实模型基线规格修正与复验；Task 7 集成审查与最终门禁

## 1. 真实模型运行配置

真实模型只通过浏览器访问本地 OpenAI-compatible 代理，不读取或注入
`LLM_API_KEY`。

| 环境变量 | 缺省值 | 说明 |
| --- | --- | --- |
| `PAGE_AGENT_EVAL_REAL` | 未启用 | 只有值为 `1` 时运行真实模型基线 |
| `PAGE_AGENT_EVAL_REAL_ENDPOINT` | `http://127.0.0.1:8788/llm/chat` | 只允许 HTTP/HTTPS loopback（`127.0.0.0/8`、`localhost`、`::1`）的精确 `/llm/chat`；尾斜杠会规范化，禁止 userinfo、query、hash 和额外 path |
| `PAGE_AGENT_EVAL_REAL_MODEL` | `LLM_MODEL` 或 `glm-4-flash` | 必须是非空模型名；随请求体传给代理，代理必须回传实际 model，客户端校验与请求值一致 |
| `PAGE_AGENT_EVAL_REAL_ATTEMPTS` | `3` | 每个场景重复次数，必须是正安全整数，上限 `20` |
| `PAGE_AGENT_EVAL_REAL_SCENARIOS` | 全部十个场景 | 逗号分隔的场景 ID；未知 ID 明确失败 |
| `PAGE_AGENT_EVAL_REAL_MAX_ROUNDS` | `20` | 单个 attempt 的模型轮次预算，必须是正安全整数，上限 `100`；超限归类 `repeated_action` |
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

### 2.3 规格审查修正

本轮继续按 RED → GREEN 修正真实模型评估契约：

| 修正项 | RED | GREEN |
| --- | --- | --- |
| 配置提取与 endpoint/model/成本门禁 | `npx vitest run evals/page-agent/realEvalConfig.spec.ts` 因缺少 `./realEvalConfig` 失败 | 20 / 20 通过 |
| 客户端实际 model 校验 | 响应缺 model 或 model 不一致时错误地 resolve | `openAICompatibleLlm.spec.ts` 8 / 8 通过 |
| 本地代理 model 契约 | 上游仍收到 `proxy-default-model`，未使用请求的 `requested-model` | 当时的 1 / 1 用例证明代理使用请求 model 调上游，但只验证了 model 回显；该 provenance 缺口已在 2.4 修正 |
| 报告 provenance | `report.spec.ts` 中 real metadata 缺少 `gitDirty` | `report.spec.ts` 13 / 13 通过；JSON 记录 revision 和 tracked dirty 状态 |
| model mismatch Playwright 门禁 | 临时代理回传 `other-model` 时 Playwright 意外退出 0 | 代理错误优先归类 `runtime_error`，相同负向用例退出 1 |

合并回归命令：

```bash
npx vitest run \
  evals/page-agent/metrics.spec.ts \
  evals/page-agent/report.spec.ts \
  evals/page-agent/scenarios.spec.ts \
  evals/page-agent/realEvalConfig.spec.ts \
  evals/page-agent/llm-proxy.spec.ts \
  evals/page-agent/site/*.spec.ts
```

结果：8 个测试文件、94 / 94 通过。

### 2.4 真实模型基线可信度加固

质量复审发现，上述 94 个测试仍未证明“代理回传的 model 来自上游”，
且 Runtime 失败、基础设施分类和长运行中间结果都存在可信度缺口。
本轮继续严格按 RED → GREEN 修正：

| 修正项 | RED | GREEN |
| --- | --- | --- |
| 实际 model provenance | `llm-proxy.spec.ts` 中上游返回 `upstream-actual-model`，代理仍回显 `requested-model`；上游缺 model 仍返回 200 | 3 / 3 通过；代理使用请求 model 调上游，但响应 model 只取上游 `payload.model`；缺失/空白返回 502 结构错误 |
| Runtime 终态不得被 DOM 成功掩盖 | navigation DOM 已成功后模拟代理 502，attempt 错误地 `passed: true` 且无 failureCode | Playwright 回归 1 / 1 通过；只有 Runtime `completed` 且页面判据成功才记为通过，失败 attempt 保留 2 steps 和 DOM 结果 |
| 稳定基础设施 marker | 网络、HTTP、body stream、结构和 model 错误都只有中文文案；`response.text()` 异常原样抛出 `body stream failed` | `openAICompatibleLlm.spec.ts` 10 / 10 通过；上述错误统一携带 `PAGE_AGENT_EVAL_REAL_INFRASTRUCTURE_ERROR`，real gate 只按 marker 判定；`AbortError` 仍保持原类型 |
| 逐 attempt checkpoint | `realEvalRunner.spec.ts` 首次运行因缺少 `./realEvalRunner` 失败 | 2 / 2 通过；第 N+1 条抛错时，前 N 条已按同一 runId 逐次 checkpoint；基础设施失败 attempt 也先写入再停止 |
| untracked provenance | `readGitDirty` 回归首次失败：方法不存在 | `report.spec.ts` 14 / 14 通过；使用正常 `git status --porcelain`，untracked 会标记 dirty，ignored `.playwright/` 不计入 |

合并回归结果：9 个测试文件、101 / 101 通过。

## 3. 失败路径门禁

| 场景 | 结果 |
| --- | --- |
| 未设置 `PAGE_AGENT_EVAL_REAL=1` | `1 skipped`；测试标题显示“设置 PAGE_AGENT_EVAL_REAL=1 后运行真实模型基线” |
| `PAGE_AGENT_EVAL_REAL_ATTEMPTS=0` | 退出码 1，提示必须是正整数 |
| `PAGE_AGENT_EVAL_REAL_MAX_ROUNDS=0` | 退出码 1，提示必须是正整数 |
| attempts 超过 `20` / maxRounds 超过 `100` | 退出码 1，提示超过成本上限 |
| 场景过滤包含 `unknown-case` | 退出码 1，明确列出未知 ID |
| endpoint 为远程 host | 退出码 1，提示只允许 loopback 本机代理 |
| 显式空白 model | 退出码 1，不回退到 `LLM_MODEL` |
| 代理端点指向不可达本地端口 | 退出码 1，错误携带 `PAGE_AGENT_EVAL_REAL_INFRASTRUCTURE_ERROR` 及 `OpenAI-compatible 代理请求失败` |
| 临时本地代理模拟 HTTP 502 / 上游 401 | 退出码 1，错误携带稳定 marker、HTTP 502 和上游 401 原因；临时服务随后已停止 |
| 代理响应 model 与请求不一致 | 退出码 1，稳定 marker 后明确列出请求 model 与上游实际 model |
| 代理成功响应缺失/空白 `payload.model` | 代理返回 502 和 `LLM 返回结构异常: 缺少实际 model` |
| 代理响应 body stream 读取失败 | 错误携带稳定 marker 和底层 stream 原因 |

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

> 上一版 `204a0b9e8251a62bef6b7b945cb85a097b5f73bc` 报告使用的代理只回显请求
> model，无法证明上游实际 model，因此已被本节新报告取代，不再作为最终基线。

为不停止或重启用户已有的 8788 代理，本轮使用更新后的
`examples/llm-proxy.mjs` 启动独立临时代理。8789 已被既有 scratchpad
进程占用，因此选用经确认空闲的 8790；本轮进程 PID 为 `43379`，
评估后已停止并确认端口释放。

smoke 命令：

```bash
PAGE_AGENT_EVAL_REAL=1 \
PAGE_AGENT_EVAL_REAL_ENDPOINT=http://127.0.0.1:8790/llm/chat \
PAGE_AGENT_EVAL_REAL_ATTEMPTS=1 \
PAGE_AGENT_EVAL_REAL_SCENARIOS=read-data \
PAGE_AGENT_EVAL_REAL_MODEL=glm-4-flash \
npx playwright test --config evals/page-agent/playwright.config.ts \
  page-agent.real.eval.spec.ts
```

结果：退出码 0，`1 passed (4.4s)`，并输出
`[real-eval] read-data attempt 1/1 checkpointed`。若上游 `payload.model`
不是 `glm-4-flash`，客户端会立即以稳定基础设施 marker 失败。

全矩阵命令：

```bash
PAGE_AGENT_EVAL_REAL_ENDPOINT=http://127.0.0.1:8790/llm/chat \
PAGE_AGENT_EVAL_REAL_MODEL=glm-4-flash \
npm run eval:page-agent:real
```

结果：退出码 0，30 条 checkpoint 进度均可见，
`1 passed (3.7m)`。

报告：

- `.playwright/网页任务完成率基线-20260802/legacy-real-glm-4-flash-20260803T062044439Z-attempts.json`
- `.playwright/网页任务完成率基线-20260802/legacy-real-glm-4-flash-20260803T062044439Z-summary.md`
- `.playwright/网页任务完成率基线-20260802/legacy-real-glm-4-flash-20260803T062044439Z-exchanges.json`

provenance 核对：

| 项目 | 结果 |
| --- | --- |
| 代码 revision | `d7fa5e1318caf9fa94ef02a60bf473e36bb059a3` |
| Git dirty | `false` |
| 实际 model | `glm-4-flash` |
| endpoint | `http://127.0.0.1:8790/llm/chat` |
| 场景 / attempts | 10 个场景，每场景 3 次，总计 30 |
| 原始交换 | 30 个 attempt 记录、143 次交换；请求 model 与上游响应 `payload.model` 均为 `glm-4-flash`，HTTP 状态均为 200 |
| model 来源证据 | 代理回应直接取自上游 `payload.model`；单测使用与请求不同的 `upstream-actual-model` 证明不是回显 |
| checkpoint | 每个 attempt 完成后以同一 runId 覆盖写入 attempts/summary/exchanges，最终共 30 条 |

最终 HEAD 会比上述报告 revision 多一个仅更新本文档的提交；
真实评估对应的代码内容仍由上述 revision 唯一标识。

总体结果：

| 指标 | 数值 |
| --- | ---: |
| 模型 | `glm-4-flash` |
| 场景数 | 10 |
| 每场景 attempts | 3 |
| 总 attempts | 30 |
| 通过 | 19 |
| 成功率 | 63.33% |
| 假成功率 | 0.00% |
| P50 / P95 steps | 3 / 20 |
| P50 / P95 耗时 | 6226 / 27022 ms |

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
| `async_loading` | 1 / 3 | 33.33% | 2 次 `repeated_action`（各 20 steps） |
| `ask_user` | 3 / 3 | 100.00% | - |
| `dynamic_dom` | 0 / 3 | 0.00% | `task_incomplete` |

## 6. 本任务验证

| 命令 | 结果 |
| --- | --- |
| `npx vitest run evals/page-agent/metrics.spec.ts evals/page-agent/report.spec.ts evals/page-agent/scenarios.spec.ts evals/page-agent/realEvalConfig.spec.ts evals/page-agent/realEvalRunner.spec.ts evals/page-agent/llm-proxy.spec.ts evals/page-agent/site/*.spec.ts` | 101 / 101 通过 |
| `npm run typecheck` | 各 workspace 与 page-agent tsconfig 均退出码 0 |
| `npm run eval:page-agent` | 3 / 3 通过，含“DOM 已成功但 Runtime 失败”回归 |
| `npx playwright test --config evals/page-agent/playwright.config.ts page-agent.real.eval.spec.ts` | 未启用时 `1 skipped`，启用提示可见 |
| 8790 `read-data × 1` 真实 smoke | `1 passed (4.4s)`，上游实际 model 校验通过 |
| 8790 `npm run eval:page-agent:real` | 30 attempts 完成且逐条 checkpoint，`1 passed (3.7m)`，退出码 0 |

## 7. 已知限制

- 30 attempts 仍封装在一个 Playwright test 内，但已在每个 attempt checkpoint
  成功后输出进度；报告采用同一 runId 覆盖写入，跨进程同名写入没有锁，单文件
  覆盖也不是原子 rename，本任务不扩展处理该一致性风险。
- 默认 20 轮是 eval-only 安全预算，防止模型循环耗尽总超时；确有更长任务时可通过
  `PAGE_AGENT_EVAL_REAL_MAX_ROUNDS` 显式覆盖，但最大值仍为 100。
- `PAGE_AGENT_EVAL_REAL_ATTEMPTS` 是 eval-only 成本门禁，每场景最多 20 次；更大样本
  需要改代码或分批运行。
- 真实模型结果不是固定 golden；引用结果时必须同时绑定 runId、revision、model、
  endpoint 和原始交换。
- 报告记录 `Browser plugin not available`；本基线未覆盖 Browser plugin 的能力差异。

## 8. Task 7 集成审查与最终门禁

### 8.1 基线、分支与端口

默认基线由 `origin/HEAD` 确认为 `origin/main`；本地 `main` 与本分支 merge-base 均为
`b1ed88fab1c2042e0b711a2fba1a10f83d598b73`。本轮开始时：

| 项目 | 结果 |
| --- | --- |
| 分支 | `test_20260802_网页任务完成率基线` |
| 代码 HEAD | `ee5cbe5987f125f4830239b3b0b83f93cfeeeb72` |
| 工作区 | clean |
| 4173 | 未监听 |
| 8788 | 用户既有 node PID `69376` 监听，未停止或重启 |
| 8789 | 用户既有 node PID `22720` 监听，未停止或重启 |
| 8790 | 未监听 |

`npm run eval:page-agent` 后再次检查，4173 和 8790 均未监听，说明本轮自启 Vite
已由 Playwright 停止；8788、8789 的 PID 与运行前一致。`npm run verify` 和文档更新前
的最终端口检查结果相同。

### 8.2 集成映射证据

计划原命令：

```bash
rg -n "read-data|navigation|search-filter|form|composite-select|rich-text|validation-recovery|async-loading|ask-user|dynamic-dom" evals/page-agent
```

退出码 0，共匹配 162 行。随后使用只读 TypeScript AST 审计分别抽取：

- `PAGE_AGENT_SCENARIOS` 的 10 个 ID 与 `id → category`；
- `scenarioDefinitions` 的 10 个 key；
- `createLegacyDeterministicCase` switch 的 10 个 case；
- `EXPECTED_OUTCOMES` 的 10 个 key；
- real 默认配置对 `PAGE_AGENT_SCENARIOS` 的复用；
- 报告对 `EVAL_CATEGORIES` 的逐类输出。

集合、唯一性和顺序检查全部为 true，映射为：

```text
read-data=>read_data
navigation=>navigation
search-filter=>search_filter
form=>form
composite-select=>composite_select
rich-text=>rich_text
validation-recovery=>validation_recovery
async-loading=>async_loading
ask-user=>ask_user
dynamic-dom=>dynamic_dom
```

辅助审计的首个 Node 22 运行方式因无法解析 TypeScript 源码中的无扩展名导入而
退出 1；改为不加载项目模块的纯 AST 审计后退出 0。该失败属于一次性审计命令的
loader 选择，不是项目测试或映射缺口。

### 8.3 新鲜验证结果

| 命令 | 退出码 | 结果 |
| --- | ---: | --- |
| `npx vitest run evals/page-agent/**/*.spec.ts` | 0 | shell 只展开到 `site/*.spec.ts`：3 个测试文件、49 / 49 通过 |
| `npx vitest run evals/page-agent` | 0 | 补齐根层用例：9 个测试文件、101 / 101 通过 |
| `npm run eval:page-agent` | 0 | 3 / 3 Playwright 测试通过，耗时 9.2s；确定性报告 8 / 10，假成功 2 / 10 |
| `npm run verify` | 0 | 57 个测试文件、828 / 828 通过；各 workspace 与 page-agent 类型检查通过；全部 workspace build 通过 |
| `git diff --check` | 0 | Task 7 文档更新后无空白错误 |
| `git diff --check main..HEAD` | 0 | 分支已提交代码相对默认基线无空白错误 |
| `npm ls @playwright/test vite --depth=0` | 0 | 直接依赖为 `@playwright/test@1.55.1`、`vite@5.4.21` |
| `git ls-files '.playwright/**'` | 0 | 无输出，ignored 报告、截图和 trace 未进入 Git |

`npm run verify` 的测试阶段出现三条 jsdom
`Not implemented: HTMLFormElement's requestSubmit() method` stderr；对应
`packages/executor/src/tools.spec.ts` 用例仍通过，最终退出码为 0。

### 8.4 基线报告复核

本轮新生成的 deterministic 报告 metadata 记录代码 revision 为 `ee5cbe5`、
`gitDirty=false`、Chromium `140.0.7339.186`，结果为 8 / 10。

真实全矩阵不重复运行，复核可信 runId `20260803T062044439Z`：

| 项目 | 复核结果 |
| --- | --- |
| revision / dirty | `d7fa5e1318caf9fa94ef02a60bf473e36bb059a3` / `false` |
| attempts | 10 个场景各 3 次，共 30 条 |
| 通过 | 19 / 30，成功率 63.33%，假成功率 0.00% |
| 交换 | 30 个 attempt 记录、143 次交换 |
| model / HTTP | 请求与上游响应 model 均为 `glm-4-flash`；HTTP 状态均为 200 |
| Browser plugin | `Browser plugin not available` |

### 8.5 最终提交关系

Task 7 未发现需要修改代码的集成 bug；本轮提交只包含 `review.md` 和本文档。
提交前代码 HEAD 为 `ee5cbe5987f125f4830239b3b0b83f93cfeeeb72`，Task 7 文档提交是其
直接子提交，不改变真实报告对应的 `d7fa5e1` 代码内容，也不重跑真实 10 × 3 矩阵。
同一提交无法在自身内容中稳定记录自己的 SHA，最终提交 SHA 在交付回报中列出。
