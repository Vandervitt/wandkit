import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { EvalAttempt, EvalFailureCode } from './metrics'
import { resolveEvalOutputDir, writeLegacyReport } from './report'
import { PAGE_AGENT_SCENARIOS } from './scenarios'

declare global {
  interface Window {
    __WANDKIT_EVAL__: {
      runLegacy(scenarioId: string): Promise<EvalAttempt>
    }
  }
}

interface ExpectedOutcome {
  readonly passed: boolean
  readonly failureCode?: EvalFailureCode
}

const EXPECTED_OUTCOMES: Readonly<Record<string, ExpectedOutcome>> = {
  'read-data': { passed: true },
  navigation: { passed: true },
  'search-filter': { passed: true },
  form: { passed: true },
  'composite-select': { passed: true },
  'rich-text': { passed: false, failureCode: 'unsupported_control' },
  'validation-recovery': { passed: true },
  'async-loading': { passed: false, failureCode: 'waiting_timeout' },
  'ask-user': { passed: true },
  'dynamic-dom': { passed: true }
}

test('旧 Runtime 确定性基线覆盖十个网页任务', async ({ page }) => {
  const consoleErrors: string[] = []
  const attempts: EvalAttempt[] = []

  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', error => consoleErrors.push(error.message))

  for (const scenario of PAGE_AGENT_SCENARIOS) {
    await page.goto(`/?scenario=${scenario.id}`)

    await expect(page).toHaveTitle('WandKit 网页任务评估')
    expect(new URL(page.url()).searchParams.get('scenario')).toBe(scenario.id)
    await expect(page.locator('[data-eval-root]')).not.toBeEmpty()
    await expect(page.locator('vite-error-overlay')).toHaveCount(0)

    const attempt = await page.evaluate(scenarioId => {
      return window.__WANDKIT_EVAL__.runLegacy(scenarioId)
    }, scenario.id)
    attempts.push(attempt)

    const expected = EXPECTED_OUTCOMES[scenario.id]
    expect(expected, `场景 ${scenario.id} 缺少预期结果`).toBeDefined()
    expect.soft(attempt, `场景 ${scenario.id} 结果漂移`).toMatchObject({
      scenarioId: scenario.id,
      category: scenario.category,
      runner: 'legacy',
      passed: expected?.passed,
      falseSuccess: false,
      ...(expected?.failureCode === undefined
        ? {}
        : { failureCode: expected.failureCode })
    })

    if (scenario.id === 'read-data') {
      await expect(page.getByRole('heading', { name: '运营概览' })).toBeVisible()
      await expect(page.getByText('1842', { exact: true })).toBeVisible()
      const outputDir = resolveEvalOutputDir()
      await mkdir(outputDir, { recursive: true })
      await page.screenshot({
        path: path.join(outputDir, 'legacy-smoke.png'),
        fullPage: false
      })
    }

    if (scenario.id === 'search-filter') {
      await expect(page.getByRole('cell', { name: '张三' })).toBeVisible()
      await expect(page.getByRole('cell', { name: '李四' })).toHaveCount(0)
    }
  }

  expect(attempts).toHaveLength(10)
  expect(attempts.filter(attempt => attempt.passed)).toHaveLength(8)
  expect(attempts.filter(attempt => !attempt.passed)).toHaveLength(2)
  expect(consoleErrors).toEqual([])

  await writeLegacyReport(attempts)
  const report = JSON.parse(await readFile(
    path.join(resolveEvalOutputDir(), 'legacy-attempts.json'),
    'utf8'
  )) as {
    metadata: { browserPlugin: string }
    attempts: EvalAttempt[]
    summary: { total: number, passed: number }
  }
  expect(report.metadata.browserPlugin).toBe('Browser plugin not available')
  expect(report.attempts).toHaveLength(10)
  expect(report.summary).toMatchObject({ total: 10, passed: 8 })
})
