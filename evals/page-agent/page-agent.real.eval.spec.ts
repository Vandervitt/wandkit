import { expect, test } from '@playwright/test'
import type { EvalAttempt } from './metrics'
import { runRealEvalMatrix } from './realEvalRunner'
import {
  writeRealReport,
  type RealReportOptions
} from './report'
import {
  REAL_EVAL_SKIP_REASON,
  resolveRealEvalConfig
} from './realEvalConfig'
import type { OpenAICompatibleExchange } from './site/openAICompatibleLlm'

interface RealEvalApi {
  runLegacyReal(
    scenarioId: string,
    options: { endpoint: string, model: string, maxRounds: number }
  ): Promise<{
    attempt: EvalAttempt
    exchanges: OpenAICompatibleExchange[]
  }>
}

const REAL_EVAL_ENABLED = process.env.PAGE_AGENT_EVAL_REAL === '1'

test(`真实模型网页基线（${REAL_EVAL_SKIP_REASON}）`, async ({
  browser,
  browserName,
  page
}) => {
  test.skip(!REAL_EVAL_ENABLED, REAL_EVAL_SKIP_REASON)
  test.setTimeout(30 * 60_000)

  const { endpoint, model, repetitions, maxRounds, scenarios } =
    resolveRealEvalConfig(process.env)
  const reportOptions: Omit<RealReportOptions, 'exchanges'> = {
    runId: createRunId(),
    model,
    repetitions,
    maxRounds,
    scenarioIds: scenarios.map(scenario => scenario.id),
    endpoint,
    browserName,
    browserVersion: browser.version(),
    browserExecutablePath: browser.browserType().executablePath()
  }
  const result = await runRealEvalMatrix({
    scenarios,
    repetitions,
    runAttempt: async ({ scenario }) => {
      await page.goto(`/?scenario=${scenario.id}`)
      return page.evaluate(async options => {
        const evalApi = (window as unknown as {
          __WANDKIT_EVAL__: RealEvalApi
        }).__WANDKIT_EVAL__
        return evalApi.runLegacyReal(
          options.scenarioId,
          {
            endpoint: options.endpoint,
            model: options.model,
            maxRounds: options.maxRounds
          }
        )
      }, { scenarioId: scenario.id, endpoint, model, maxRounds })
    },
    checkpoint: async (records, exchanges) => {
      await writeRealReport(records, { ...reportOptions, exchanges })
    },
    onProgress: message => console.log(`[real-eval] ${message}`)
  })

  const files = await writeRealReport(result.records, {
    ...reportOptions,
    exchanges: result.exchangeRecords
  })
  test.info().annotations.push({
    type: '真实模型报告',
    description: files.markdown
  })

  expect(
    result.infrastructureFailures,
    result.infrastructureFailures.map(attempt =>
      `${attempt.scenarioId}: ${attempt.failureMessage ?? '未知代理错误'}`
    ).join('\n')
  ).toEqual([])
  expect(result.records).toHaveLength(scenarios.length * repetitions)
  for (const record of result.records) {
    expect(record.result).toMatchObject({
      runner: 'legacy',
      model
    })
  }
})

function createRunId(): string {
  return new Date().toISOString().replace(/[-:.]/g, '')
}
