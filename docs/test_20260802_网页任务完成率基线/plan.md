# 网页任务完成率基线 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立可在真实浏览器中运行、可比较旧 Runtime 与未来 PageAgentRuntime 的网页任务完成率基线。

**Architecture:** 评估契约与统计保持为纯 TypeScript；Vite 提供本地网页场景；Playwright 驱动页面并调用 Runner；当前 Runner 复用 `AgentRuntime + createPageTools`。确定性回归使用脚本模型，真实模型通过现有本地 LLM 代理运行。

**Tech Stack:** TypeScript、Vitest、Vite、Playwright、现有 Wandkit packages。

---

### Task 1: 评估指标契约与聚合

**Files:**
- Create: `evals/page-agent/metrics.ts`
- Create: `evals/page-agent/metrics.spec.ts`
- Modify: `vitest.config.ts`

- [ ] **Step 1: 写失败测试，定义总体与分类统计行为**

```ts
const summary = summarizeAttempts([
  attempt({ category: 'read_data', passed: true, durationMs: 100, steps: 2 }),
  attempt({ category: 'read_data', passed: false, falseSuccess: true, durationMs: 300, steps: 6 })
])

expect(summary.total).toBe(2)
expect(summary.successRate).toBe(0.5)
expect(summary.falseSuccessRate).toBe(0.5)
expect(summary.byCategory.read_data.successRate).toBe(0.5)
expect(summary.durationMs.p50).toBe(100)
expect(summary.durationMs.p95).toBe(300)
```

- [ ] **Step 2: 运行测试并确认因模块不存在而失败**

Run: `npx vitest run evals/page-agent/metrics.spec.ts`

Expected: FAIL，提示无法解析 `./metrics`。

- [ ] **Step 3: 实现契约、百分位数与 Markdown/JSON 序列化**

```ts
export interface EvalSummary {
  total: number
  passed: number
  successRate: number
  falseSuccessRate: number
  steps: { p50: number; p95: number }
  durationMs: { p50: number; p95: number }
  byCategory: Record<EvalCategory, CategorySummary>
}

export function summarizeAttempts(attempts: readonly EvalAttempt[]): EvalSummary
export function formatEvalSummaryMarkdown(summary: EvalSummary): string
```

- [ ] **Step 4: 重跑指标测试**

Run: `npx vitest run evals/page-agent/metrics.spec.ts`

Expected: PASS。

### Task 2: 场景目录与成功判据

**Files:**
- Create: `evals/page-agent/scenarios.ts`
- Create: `evals/page-agent/scenarios.spec.ts`

- [ ] **Step 1: 写失败测试，钉死十类场景和唯一 ID**

```ts
expect(PAGE_AGENT_SCENARIOS).toHaveLength(10)
expect(new Set(PAGE_AGENT_SCENARIOS.map(item => item.id)).size).toBe(10)
expect(new Set(PAGE_AGENT_SCENARIOS.map(item => item.category))).toEqual(new Set([
  'read_data', 'navigation', 'search_filter', 'form', 'composite_select',
  'rich_text', 'validation_recovery', 'async_loading', 'ask_user', 'dynamic_dom'
]))
```

- [ ] **Step 2: 运行测试并确认场景目录不存在**

Run: `npx vitest run evals/page-agent/scenarios.spec.ts`

Expected: FAIL，提示无法解析 `./scenarios`。

- [ ] **Step 3: 创建十个场景元数据**

```ts
export interface EvalScenario {
  id: string
  category: EvalCategory
  title: string
  task: string
  expected: string
}
```

每个场景只保存稳定元数据；DOM 构建与判据实现放在场景站点，避免 Node 与浏览器职责混杂。

- [ ] **Step 4: 重跑场景测试**

Run: `npx vitest run evals/page-agent/scenarios.spec.ts`

Expected: PASS。

### Task 3: 浏览器场景站点

**Files:**
- Create: `evals/page-agent/vite.config.ts`
- Create: `evals/page-agent/site/index.html`
- Create: `evals/page-agent/site/main.ts`
- Create: `evals/page-agent/site/scenarioRegistry.ts`
- Create: `evals/page-agent/site/scenarioRegistry.spec.ts`

- [ ] **Step 1: 写失败测试，验证十个场景都能挂载并重置**

```ts
for (const scenario of PAGE_AGENT_SCENARIOS) {
  const mounted = mountScenario(scenario.id, document.body)
  expect(mounted.id).toBe(scenario.id)
  expect(document.querySelector('[data-eval-root]')).not.toBeNull()
  mounted.reset()
}
```

- [ ] **Step 2: 运行测试并确认 registry 不存在**

Run: `npx vitest run evals/page-agent/site/scenarioRegistry.spec.ts`

Expected: FAIL，提示无法解析 `./scenarioRegistry`。

- [ ] **Step 3: 实现场景页面与判据接口**

```ts
export interface MountedScenario {
  id: string
  task: string
  evaluate(answer: string): { passed: boolean; falseSuccess: boolean; detail?: string }
  reset(): void
}

export function mountScenario(id: string, root: HTMLElement): MountedScenario
```

场景必须包含真实 DOM 更新、异步渲染、表单校验和元素替换，禁止仅修改测试变量模拟成功。

- [ ] **Step 4: 重跑 registry 测试**

Run: `npx vitest run evals/page-agent/site/scenarioRegistry.spec.ts`

Expected: PASS。

### Task 4: 旧 Runtime Runner

**Files:**
- Create: `evals/page-agent/site/scriptedLlm.ts`
- Create: `evals/page-agent/site/legacyRuntime.ts`
- Create: `evals/page-agent/site/legacyRuntime.spec.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: 写失败测试，证明 Runner 能返回回答、步骤与终态**

```ts
const result = await runLegacyRuntime({
  task: '读取统计数字',
  replies: [toolCall('page_read_v1', {}), finalAnswer('共有 1842 条')]
})

expect(result.status).toBe('completed')
expect(result.answer).toContain('1842')
expect(result.steps).toBe(1)
```

- [ ] **Step 2: 运行测试并确认 Runner 不存在**

Run: `npx vitest run evals/page-agent/site/legacyRuntime.spec.ts`

Expected: FAIL，提示无法解析 `./legacyRuntime`。

- [ ] **Step 3: 复用现有 Runtime 和页面原语实现 Runner**

```ts
export interface LegacyRuntimeResult {
  status: 'completed' | 'failed' | 'cancelled' | 'awaiting_confirmation'
  answer: string
  steps: number
  stopReason?: string
}

export async function runLegacyRuntime(options: LegacyRuntimeOptions): Promise<LegacyRuntimeResult>
```

只增加必要的 `LlmClient` 类型导出，不改变 `AgentRuntime` 的执行行为。

- [ ] **Step 4: 重跑 Runner 测试和现有 core/executor 测试**

Run: `npx vitest run evals/page-agent/site/legacyRuntime.spec.ts packages/core/src/runtime/agentRuntime.spec.ts packages/executor/src/tools.spec.ts`

Expected: PASS。

### Task 5: Playwright 确定性基线

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `evals/page-agent/playwright.config.ts`
- Create: `evals/page-agent/page-agent.eval.spec.ts`
- Create: `evals/page-agent/report.ts`

- [ ] **Step 1: 安装直接依赖并写失败 E2E**

Run: `npm install --save-dev @playwright/test vite`

测试先断言 `read-data` 场景通过，并断言 `rich-text` 基线被统计为 `unsupported_control`，而不是让整个 Eval 套件失败。

- [ ] **Step 2: 运行 Playwright 并确认因站点/Runner 接线缺失而失败**

Run: `npx playwright test --config evals/page-agent/playwright.config.ts`

Expected: FAIL，失败原因是页面尚未暴露 `window.__WANDKIT_EVAL__`。

- [ ] **Step 3: 接通页面入口、脚本模型、判据和报告器**

```ts
declare global {
  interface Window {
    __WANDKIT_EVAL__: {
      runLegacy(scenarioId: string): Promise<EvalAttempt>
    }
  }
}
```

报告写入 `PLAYWRIGHT_OUTPUT_DIR` 指定目录；缺省为 `.playwright/网页任务完成率基线-20260802/`。

- [ ] **Step 4: 运行确定性 E2E**

Run: `npm run eval:page-agent`

Expected: Playwright 进程退出码 0；报告中同时存在通过场景和已分类的基线失败场景。

### Task 6: 可选真实模型基线

**Files:**
- Create: `evals/page-agent/site/openAICompatibleLlm.ts`
- Create: `evals/page-agent/page-agent.real.eval.spec.ts`
- Modify: `evals/page-agent/playwright.config.ts`
- Modify: `package.json`
- Create: `docs/test_20260802_网页任务完成率基线/test-results.md`

- [ ] **Step 1: 写真实模型测试并在未启用时显式 skip**

```ts
test.skip(process.env.PAGE_AGENT_EVAL_REAL !== '1', '设置 PAGE_AGENT_EVAL_REAL=1 后运行真实模型基线')
```

- [ ] **Step 2: 启用真实模式，确认缺少代理或 Key 时明确失败**

Run: `PAGE_AGENT_EVAL_REAL=1 npx playwright test --config evals/page-agent/playwright.config.ts page-agent.real.eval.spec.ts`

Expected: 若环境未配置，FAIL 并展示本地代理启动或鉴权原因；不得变成通过。

- [ ] **Step 3: 复用 `/llm/chat` OpenAI-compatible 代理并累计尝试**

每个场景默认运行三次，模型名、重复次数和场景过滤均由环境变量覆盖。原始交换仅保存在 Playwright ignored 目录。

- [ ] **Step 4: 有可用 Key 时运行真实基线并记录结果；无 Key 时记录未执行原因**

Run: `npm run eval:page-agent:real`

Expected: 有 Key 时生成真实模型汇总；无 Key 时在 `test-results.md` 如实记录跳过及原因。

### Task 7: 集成审查与完整验证

**Files:**
- Create: `docs/test_20260802_网页任务完成率基线/review.md`
- Modify: `docs/test_20260802_网页任务完成率基线/test-results.md`

- [ ] **Step 1: 核对场景 ID、页面 registry、Playwright case 和报告类别一一对应**

Run: `rg -n "read-data|navigation|search-filter|form|composite-select|rich-text|validation-recovery|async-loading|ask-user|dynamic-dom" evals/page-agent`

- [ ] **Step 2: 运行分层验证**

Run: `npx vitest run evals/page-agent/**/*.spec.ts`

Run: `npm run eval:page-agent`

Run: `npm run verify`

Expected: 三条命令退出码均为 0。

- [ ] **Step 3: 回填测试、审查和已知限制**

`test-results.md` 记录实际命令、退出码、通过数、真实模型是否执行；`review.md` 记录规格符合性、代码质量和剩余风险。

- [ ] **Step 4: 按逻辑分组提交并推送**

提交前重新检查分支：

```bash
git branch --show-current
git branch -vv
```

提交信息使用：

```bash
git commit -m "test: 建立网页任务完成率基线"
git push -u origin test_20260802_网页任务完成率基线:test_20260802_网页任务完成率基线
```
