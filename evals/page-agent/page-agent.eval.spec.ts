import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { EvalAttempt, EvalFailureCode } from './metrics'
import { resolveEvalOutputDir, writeLegacyReport } from './report'
import { PAGE_AGENT_SCENARIOS } from './scenarios'
import type { MountedScenario } from './site/scenarioRegistry'

declare global {
  interface Window {
    __WANDKIT_SCENARIO__: MountedScenario
    __WANDKIT_EVAL__: {
      runLegacy(scenarioId: string): Promise<EvalAttempt>
    }
  }
}

interface ExpectedOutcome {
  readonly passed: boolean
  readonly falseSuccess: boolean
  readonly steps: number
  readonly failureCode?: EvalFailureCode
}

const EXPECTED_OUTCOMES: Readonly<Record<string, ExpectedOutcome>> = {
  'read-data': { passed: true, falseSuccess: false, steps: 1 },
  navigation: { passed: true, falseSuccess: false, steps: 2 },
  'search-filter': { passed: true, falseSuccess: false, steps: 3 },
  form: { passed: true, falseSuccess: false, steps: 4 },
  'composite-select': { passed: true, falseSuccess: false, steps: 3 },
  'rich-text': {
    passed: false,
    falseSuccess: true,
    steps: 3,
    failureCode: 'unsupported_control'
  },
  'validation-recovery': { passed: true, falseSuccess: false, steps: 5 },
  'async-loading': {
    passed: false,
    falseSuccess: true,
    steps: 4,
    failureCode: 'waiting_timeout'
  },
  'ask-user': { passed: true, falseSuccess: false, steps: 0 },
  'dynamic-dom': { passed: true, falseSuccess: false, steps: 4 }
}

test('旧 Runtime 确定性基线覆盖十个网页任务', async ({
  browser,
  browserName,
  page
}) => {
  const consoleErrors: string[] = []
  const attempts: EvalAttempt[] = []
  const pageObservations: Array<{
    scenarioId: string
    title: string
    url: string
    evalRootText: string
    viteOverlayCount: number
  }> = []
  let searchShowsOnlyZhangSan = false

  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', error => consoleErrors.push(error.message))

  for (const scenario of PAGE_AGENT_SCENARIOS) {
    await page.goto(`/?scenario=${scenario.id}`)

    const attempt = await page.evaluate(scenarioId => {
      return window.__WANDKIT_EVAL__.runLegacy(scenarioId)
    }, scenario.id)
    attempts.push(attempt)
    pageObservations.push({
      scenarioId: scenario.id,
      title: await page.title(),
      url: page.url(),
      evalRootText: await page.locator('[data-eval-root]').innerText(),
      viteOverlayCount: await page.locator('vite-error-overlay').count()
    })

    if (scenario.id === 'read-data') {
      const outputDir = resolveEvalOutputDir()
      await mkdir(outputDir, { recursive: true })
      await page.screenshot({
        path: path.join(outputDir, 'legacy-smoke.png'),
        fullPage: false
      })
    }

    if (scenario.id === 'search-filter') {
      searchShowsOnlyZhangSan =
        await page.getByRole('cell', { name: '张三' }).count() === 1 &&
        await page.getByRole('cell', { name: '李四' }).count() === 0
    }
  }

  await writeLegacyReport(attempts, {
    browserName,
    browserVersion: browser.version(),
    browserExecutablePath: browser.browserType().executablePath()
  })

  for (const [index, scenario] of PAGE_AGENT_SCENARIOS.entries()) {
    const observation = pageObservations[index]
    expect.soft(observation, `场景 ${scenario.id} 页面身份漂移`).toMatchObject({
      scenarioId: scenario.id,
      title: 'WandKit 网页任务评估',
      viteOverlayCount: 0
    })
    expect.soft(observation?.evalRootText.trim()).not.toBe('')
    expect.soft(new URL(observation?.url ?? '').searchParams.get('scenario'))
      .toBe(scenario.id)

    const expected = EXPECTED_OUTCOMES[scenario.id]
    expect(expected, `场景 ${scenario.id} 缺少预期结果`).toBeDefined()
    expect.soft(attempts[index], `场景 ${scenario.id} 结果漂移`).toMatchObject({
      scenarioId: scenario.id,
      category: scenario.category,
      runner: 'legacy',
      passed: expected?.passed,
      falseSuccess: expected?.falseSuccess,
      steps: expected?.steps,
      ...(expected?.failureCode === undefined
        ? {}
        : { failureCode: expected.failureCode })
    })
  }

  expect(attempts).toHaveLength(10)
  expect(attempts.filter(attempt => attempt.passed)).toHaveLength(8)
  expect(attempts.filter(attempt => !attempt.passed)).toHaveLength(2)
  expect(attempts.filter(attempt => attempt.falseSuccess)).toHaveLength(2)
  expect(searchShowsOnlyZhangSan).toBe(true)
  expect(consoleErrors).toEqual([])

  const report = JSON.parse(await readFile(
    path.join(resolveEvalOutputDir(), 'legacy-attempts.json'),
    'utf8'
  )) as {
    metadata: {
      browserPlugin: string
      browserName: string
      browserVersion: string
      gitRevision: string
    }
    attempts: EvalAttempt[]
    summary: {
      total: number
      passed: number
      falseSuccessRate: number
      steps: { p50: number, p95: number }
    }
  }
  expect(report.metadata.browserPlugin).toBe('Browser plugin not available')
  expect(report.metadata.browserName).toBe(browserName)
  expect(report.metadata.browserVersion).toBe(browser.version())
  expect(report.metadata.gitRevision).toMatch(/^[0-9a-f]{40}$/)
  expect(report.attempts).toHaveLength(10)
  expect(report.summary).toMatchObject({
    total: 10,
    passed: 8,
    falseSuccessRate: 0.2,
    steps: { p50: 3, p95: 5 }
  })
})

test('最终判据异常时保留 Runtime 已发生的动作步骤', async ({ page }) => {
  await page.goto('/?scenario=read-data')

  const attempt = await page.evaluate(async () => {
    const mounted = window.__WANDKIT_SCENARIO__ as unknown as {
      evaluate(answer: string): { passed: boolean, falseSuccess: boolean }
    }
    mounted.evaluate = () => {
      throw new Error('evaluate failed after runtime')
    }
    return window.__WANDKIT_EVAL__.runLegacy('read-data')
  })

  expect(attempt).toMatchObject({
    scenarioId: 'read-data',
    passed: false,
    falseSuccess: false,
    steps: 1,
    failureCode: 'runtime_error',
    failureMessage: 'evaluate failed after runtime'
  })
})
