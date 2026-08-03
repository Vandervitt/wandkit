# 网页任务完成率基线集成审查

> 分支：`test_20260802_网页任务完成率基线`
> 基线：`main` / `b1ed88fab1c2042e0b711a2fba1a10f83d598b73`
> 审查代码 HEAD：`ee5cbe5987f125f4830239b3b0b83f93cfeeeb72`
> 日期：2026-08-03

## 1. 审查范围

本轮审查覆盖 `main..ee5cbe5` 的 18 个提交、34 个变更文件，重点核对：

- 十个场景的 ID、类别、页面 registry、确定性脚本、确定性 Playwright
  期望、真实矩阵默认输入和报告分类是否一致；
- `EvalAttempt`、真实模型配置、Runner 返回值和 JSON/Markdown 报告字段是否贯通；
- `package.json` 脚本、Vitest/Playwright/Vite 配置、直接依赖和 `.playwright/`
  ignore 是否形成可重复执行的入口；
- Task 5、Task 6 审查问题是否由测试和提交闭环；
- 设计范围是否保持在评估设施内，未修改生产 `AgentRuntime` 行为。

## 2. 规格符合性

| 规格项 | 证据 | 结论 |
| --- | --- | --- |
| 十类真实网页任务 | `PAGE_AGENT_SCENARIOS` 定义 10 个唯一 ID，类别集合严格等于 `EVAL_CATEGORIES`；`scenarios.spec.ts` 新鲜通过 | 符合 |
| 页面终态与最终回答共同判定 | `scenarioRegistry.ts` 为每个场景实现真实 DOM 变化和 `evaluate`；读取、异步和追问场景同时检查回答 | 符合 |
| 假成功独立统计 | `EvalAttempt.falseSuccess`、总体/分类 `falseSuccessRate`、确定性报告 2 / 10 假成功 | 符合 |
| Runner 与场景解耦 | 场景元数据、registry、`runLegacyRuntime` 和报告聚合分层；Runner 通过场景目录取得 task/category | 符合 |
| 确定性与真实模型双入口 | `npm run eval:page-agent` 只选择 deterministic spec；`npm run eval:page-agent:real` 显式启用 real spec | 符合 |
| 真实模式缺少配置不静默成功 | endpoint、model、attempts、rounds、场景过滤均有负向门禁；基础设施错误使用稳定 marker 并令 Playwright 失败 | 符合 |
| Key 不进入浏览器 | 浏览器只访问 loopback `/llm/chat`，请求不含鉴权头；本地代理独占 `LLM_API_KEY` | 符合 |
| 报告可比较 | 报告包含 revision/dirty、Node/OS、Playwright/Chromium、model、runId、总体/分类统计和场景明细 | 符合 |
| 产物不进入 Git | `resolveEvalOutputDir` 仅允许 `.playwright/` 明确后代；`.gitignore` 命中报告和 trace，`git ls-files '.playwright/**'` 为空 | 符合 |
| 不改变生产 Runtime 行为 | 生产代码只新增 `LlmClient` 类型导出；轮次上限位于 real eval LLM 客户端 | 符合 |

## 3. Task 5 / Task 6 审查闭环

| 审查 | 已关闭问题 | 关闭证据 |
| --- | --- | --- |
| Task 5 集成与报告审查（`f06c4e8`） | 确定性期望未钉死 steps/falseSuccess；失败分类由脚本预置而非终态推导；最终判据异常会丢失已发生步骤；报告缺少可比较的浏览器与 revision 信息；输出目录和 artifacts 未隔离 | `page-agent.eval.spec.ts` 钉死 10 场景结果并覆盖判据异常；`main.ts` 从 Runtime/DOM 终态分类；`report.spec.ts` 覆盖 metadata、目录越界和符号链接；本轮 deterministic E2E 3 / 3 通过 |
| Task 6 第一轮契约审查（`204a0b9`） | real 配置散落；loopback/path、非空 model、未知场景和成本上限缺少集中门禁；客户端未校验响应 model；报告缺少 dirty provenance；模型不一致未成为 Playwright 门禁 | `realEvalConfig.spec.ts` 20 / 20、`openAICompatibleLlm.spec.ts` 10 / 10、`report.spec.ts` 14 / 14 在本轮完整 Vitest 中通过；负向门禁证据保留在 `test-results.md` |
| Task 6 第二轮信度审查（`d7fa5e1`） | 代理曾回显请求 model，不能证明上游实际 model；DOM 成功可能掩盖 Runtime 失败；基础设施错误依赖文案；长矩阵缺少逐 attempt checkpoint；untracked 未计入 dirty | 代理只回传上游 `payload.model` 且缺失时返回 502；Playwright 回归覆盖 DOM 成功但 Runtime 失败；稳定 infrastructure marker；`realEvalRunner.spec.ts` 2 / 2 覆盖 checkpoint/中止；`readGitDirty` 包含 untracked |

以上问题均已由当前分支代码和测试覆盖关闭；本轮未发现新的集成映射缺口，
因此没有修改评估代码。

## 4. 十场景集成映射

只读 AST 审计从五处分别抽取 ID：`PAGE_AGENT_SCENARIOS`、
`scenarioDefinitions`、`createLegacyDeterministicCase` 的 switch、
`EXPECTED_OUTCOMES` 和 real 默认场景目录。五组均为以下 10 个唯一 ID，集合无缺失、
无额外项；real 默认顺序与场景目录一致。

| 场景 ID | 报告类别 |
| --- | --- |
| `read-data` | `read_data` |
| `navigation` | `navigation` |
| `search-filter` | `search_filter` |
| `form` | `form` |
| `composite-select` | `composite_select` |
| `rich-text` | `rich_text` |
| `validation-recovery` | `validation_recovery` |
| `async-loading` | `async_loading` |
| `ask-user` | `ask_user` |
| `dynamic-dom` | `dynamic_dom` |

报告的分类行由 `EVAL_CATEGORIES.map(...)` 生成；上述 10 个场景类别唯一且顺序
与 `EVAL_CATEGORIES` 完全相同。`rg` 原命令退出码 0，共匹配 162 行；
`scenarios.spec.ts`、`scenarioRegistry.spec.ts` 以及确定性 Playwright 又分别从运行时
验证了映射和挂载行为。

## 5. 基线结果

### 5.1 确定性基线

本轮 `npm run eval:page-agent` 退出码 0，3 / 3 个 Playwright 测试通过。
新生成的 ignored 报告记录 10 个场景通过 8 个，成功率 80.00%，假成功 2 / 10；
`rich-text` 为 `unsupported_control`，`async-loading` 为 `waiting_timeout`。

### 5.2 真实模型基线

本轮不重复 10 × 3 真实矩阵。可信报告 runId 为
`20260803T062044439Z`，代码 revision 为
`d7fa5e1318caf9fa94ef02a60bf473e36bb059a3`，`gitDirty=false`。
报告包含 30 条 attempt、30 条 exchange attempt 记录和 143 次交换；请求 model、
上游响应 model 均为 `glm-4-flash`，HTTP 状态均为 200。

真实基线通过 19 / 30，成功率 63.33%，假成功率 0.00%；P50 / P95 steps
为 3 / 20，P50 / P95 耗时为 6226 / 27022 ms。分类结果与
`test-results.md` 第 5 节一致。

## 6. 代码质量结论

- 字段契约由 `metrics.ts` 集中定义，场景目录是 ID/category 的单一来源；
  deterministic 和 real attempt 都从场景对象写入 `scenarioId`、`category`。
- registry 的 DOM、监听器、timer 和导航 hash 均有 reset/dispose 回归；Runner 使用
  独立 trace storage，并在 `finally` 释放页面控制器和请求跟踪。
- real endpoint 限制为 loopback 精确 `/llm/chat`，model、attempts、rounds 和场景
  过滤在浏览器运行前完成校验；基础设施失败与任务失败分开处理。
- 报告路径有根目录、越界和现存符号链接防护；Markdown 单元格会转义；ignored
  产物未被 Git 跟踪。
- `npm run verify` 新鲜通过 57 个测试文件、828 个测试，随后类型检查和所有 workspace
  构建均退出 0；本轮代码审查没有发现需要新增失败测试的集成 bug。

结论：Task 7 集成审查通过，代码与已批准设计一致，可以保留当前开发分支交由用户
后续处理；本任务不 push、不合并 `dev` / `test` / `main`。

## 7. 剩余风险

- 固定报告文件在同一 runId checkpoint 时通过并行 `writeFile` 直接覆盖；跨进程同名
  写入没有锁，单文件替换也不是原子 rename，进程中断或并发运行可能得到不一致文件。
- `PAGE_AGENT_EVAL_REAL_ATTEMPTS` 的 eval-only 成本上限为每场景 20 次；更大统计样本
  需要调整实现或分批运行，不能仅靠环境变量突破该上限。
- 真实模型结果受模型服务和页面执行时序影响，不是固定 golden；可信结论必须绑定
  runId、代码 revision、model、endpoint 和原始交换重新解释。
- 报告明确记录 `Browser plugin not available`；当前基线只验证 Playwright Chromium，
  未覆盖 Browser plugin 提供的额外能力或差异。
- 单 attempt 默认 20 轮是 eval-only 防循环预算；更长但合理的任务可能被归类为
  `repeated_action`，需要结合原始交换判断是否调整到允许的最大 100 轮。
