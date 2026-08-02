export type EvalCategory =
  | 'read_data'
  | 'navigation'
  | 'search_filter'
  | 'form'
  | 'composite_select'
  | 'rich_text'
  | 'validation_recovery'
  | 'async_loading'
  | 'ask_user'
  | 'dynamic_dom'

export type EvalFailureCode =
  | 'model_protocol'
  | 'observation_miss'
  | 'stale_index'
  | 'action_no_effect'
  | 'unsupported_control'
  | 'validation_error'
  | 'waiting_timeout'
  | 'user_input_required'
  | 'repeated_action'
  | 'task_incomplete'
  | 'runtime_error'

export interface EvalAttempt {
  scenarioId: string
  category: EvalCategory
  runner: string
  model?: string
  passed: boolean
  falseSuccess: boolean
  durationMs: number
  steps: number
  promptTokens?: number
  completionTokens?: number
  failureCode?: EvalFailureCode
  failureMessage?: string
}

export interface CategorySummary {
  total: number
  passed: number
  successRate: number
  falseSuccessRate: number
}

export interface EvalSummary extends CategorySummary {
  steps: {
    p50: number
    p95: number
  }
  durationMs: {
    p50: number
    p95: number
  }
  byCategory: Record<EvalCategory, CategorySummary>
}

const EVAL_CATEGORIES: readonly EvalCategory[] = [
  'read_data',
  'navigation',
  'search_filter',
  'form',
  'composite_select',
  'rich_text',
  'validation_recovery',
  'async_loading',
  'ask_user',
  'dynamic_dom'
]

interface CategoryCounts {
  total: number
  passed: number
  falseSuccesses: number
}

export function summarizeAttempts(attempts: readonly EvalAttempt[]): EvalSummary {
  const categoryCounts = Object.fromEntries(
    EVAL_CATEGORIES.map(category => [
      category,
      { total: 0, passed: 0, falseSuccesses: 0 }
    ])
  ) as Record<EvalCategory, CategoryCounts>

  let passed = 0
  let falseSuccesses = 0
  for (const attempt of attempts) {
    const counts = categoryCounts[attempt.category]
    counts.total += 1
    if (attempt.passed) {
      passed += 1
      counts.passed += 1
    }
    if (attempt.falseSuccess) {
      falseSuccesses += 1
      counts.falseSuccesses += 1
    }
  }

  const total = attempts.length
  const byCategory = Object.fromEntries(
    EVAL_CATEGORIES.map(category => {
      const counts = categoryCounts[category]
      return [category, toCategorySummary(counts)]
    })
  ) as Record<EvalCategory, CategorySummary>

  return {
    total,
    passed,
    successRate: rate(passed, total),
    falseSuccessRate: rate(falseSuccesses, total),
    steps: percentiles(attempts.map(attempt => attempt.steps)),
    durationMs: percentiles(attempts.map(attempt => attempt.durationMs)),
    byCategory
  }
}

export function formatEvalSummaryMarkdown(summary: EvalSummary): string {
  const categoryRows = EVAL_CATEGORIES.map(category => {
    const item = summary.byCategory[category]
    return `| ${category} | ${item.total} | ${item.passed} | ${percentage(item.successRate)} | ${percentage(item.falseSuccessRate)} |`
  })

  return [
    '# 网页任务评估摘要',
    '',
    '## 总体',
    '',
    '| 指标 | 数值 |',
    '| --- | ---: |',
    `| 总尝试数 | ${summary.total} |`,
    `| 通过数 | ${summary.passed} |`,
    `| 成功率 | ${percentage(summary.successRate)} |`,
    `| 假成功率 | ${percentage(summary.falseSuccessRate)} |`,
    `| P50 步骤数 | ${summary.steps.p50} |`,
    `| P95 步骤数 | ${summary.steps.p95} |`,
    `| P50 耗时 | ${summary.durationMs.p50} ms |`,
    `| P95 耗时 | ${summary.durationMs.p95} ms |`,
    '',
    '## 分类',
    '',
    '| 类别 | 总数 | 通过 | 成功率 | 假成功率 |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...categoryRows,
    ''
  ].join('\n')
}

function toCategorySummary(counts: CategoryCounts): CategorySummary {
  return {
    total: counts.total,
    passed: counts.passed,
    successRate: rate(counts.passed, counts.total),
    falseSuccessRate: rate(counts.falseSuccesses, counts.total)
  }
}

function rate(count: number, total: number): number {
  return total === 0 ? 0 : count / total
}

function percentiles(values: readonly number[]): { p50: number; p95: number } {
  return {
    p50: nearestRank(values, 0.5),
    p95: nearestRank(values, 0.95)
  }
}

function nearestRank(values: readonly number[], percentile: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.max(0, Math.ceil(percentile * sorted.length) - 1)
  return sorted[index]
}

function percentage(rateValue: number): string {
  return `${(rateValue * 100).toFixed(2)}%`
}
