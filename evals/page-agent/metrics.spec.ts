import { describe, expect, it } from 'vitest'
import {
  EVAL_CATEGORIES,
  formatEvalSummaryMarkdown,
  summarizeAttempts,
  type EvalAttempt,
  type EvalCategory,
  type EvalFailureCode
} from './metrics'

const categories: readonly EvalCategory[] = EVAL_CATEGORIES

function attempt(overrides: Partial<EvalAttempt> = {}): EvalAttempt {
  return {
    scenarioId: 'read-data',
    category: 'read_data',
    runner: 'legacy',
    passed: true,
    falseSuccess: false,
    durationMs: 100,
    steps: 2,
    ...overrides
  }
}

describe('summarizeAttempts', () => {
  it('聚合总体、分类和 nearest-rank 百分位', () => {
    const failureCode: EvalFailureCode = 'task_incomplete'
    const attempts = [
      attempt({
        scenarioId: 'read-data-failed',
        passed: false,
        falseSuccess: true,
        durationMs: 300,
        steps: 6,
        failureCode
      }),
      attempt({ scenarioId: 'read-data-passed', durationMs: 100, steps: 2 })
    ]

    const summary = summarizeAttempts(attempts)

    expect(summary).toMatchObject({
      total: 2,
      passed: 1,
      successRate: 0.5,
      falseSuccessRate: 0.5,
      steps: { p50: 2, p95: 6 },
      durationMs: { p50: 100, p95: 300 }
    })
    expect(summary.byCategory.read_data).toEqual({
      total: 2,
      passed: 1,
      successRate: 0.5,
      falseSuccessRate: 0.5
    })
  })

  it('空尝试返回零值并保留全部十类', () => {
    const summary = summarizeAttempts([])

    expect(summary).toMatchObject({
      total: 0,
      passed: 0,
      successRate: 0,
      falseSuccessRate: 0,
      steps: { p50: 0, p95: 0 },
      durationMs: { p50: 0, p95: 0 }
    })
    expect(Object.keys(summary.byCategory)).toEqual(categories)
    for (const category of categories) {
      expect(summary.byCategory[category]).toEqual({
        total: 0,
        passed: 0,
        successRate: 0,
        falseSuccessRate: 0
      })
    }
  })

  it('未出现的类别仍存在且统计为零', () => {
    const summary = summarizeAttempts([
      attempt({ category: 'navigation', scenarioId: 'navigation' })
    ])

    expect(summary.byCategory.navigation.total).toBe(1)
    expect(summary.byCategory.rich_text).toEqual({
      total: 0,
      passed: 0,
      successRate: 0,
      falseSuccessRate: 0
    })
  })

  it('不修改输入数组及尝试对象', () => {
    const attempts = [
      attempt({ scenarioId: 'slower', durationMs: 300, steps: 6 }),
      attempt({ scenarioId: 'faster', durationMs: 100, steps: 2 })
    ]
    const original = structuredClone(attempts)

    summarizeAttempts(attempts)

    expect(attempts).toEqual(original)
  })
})

describe('formatEvalSummaryMarkdown', () => {
  it('输出总体指标和全部分类数据，百分比保留两位小数', () => {
    const summary = summarizeAttempts([
      attempt(),
      attempt({ passed: false, falseSuccess: true, durationMs: 300, steps: 6 })
    ])

    const markdown = formatEvalSummaryMarkdown(summary)

    expect(markdown).toContain('| 总尝试数 | 2 |')
    expect(markdown).toContain('| 成功率 | 50.00% |')
    expect(markdown).toContain('| 假成功率 | 50.00% |')
    expect(markdown).toContain('| P50 步骤数 | 2 |')
    expect(markdown).toContain('| P95 步骤数 | 6 |')
    expect(markdown).toContain('| P50 耗时 | 100 ms |')
    expect(markdown).toContain('| P95 耗时 | 300 ms |')
    expect(markdown).toContain('| read_data | 2 | 1 | 50.00% | 50.00% |')
    expect(markdown).toContain('| dynamic_dom | 0 | 0 | 0.00% | 0.00% |')
    const categoryRows = markdown.split('\n').filter(row => {
      return EVAL_CATEGORIES.some(category => row.startsWith(`| ${category} |`))
    })
    expect(categoryRows).toHaveLength(EVAL_CATEGORIES.length)
  })

  it('将三分之一成功率格式化为 33.33%', () => {
    const summary = summarizeAttempts([
      attempt(),
      attempt({ passed: false }),
      attempt({ passed: false })
    ])

    const markdown = formatEvalSummaryMarkdown(summary)

    expect(markdown).toContain('| 成功率 | 33.33% |')
    expect(markdown).toContain('| read_data | 3 | 1 | 33.33% | 0.00% |')
  })
})
