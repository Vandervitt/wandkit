import { expect, test } from '@playwright/test'
import type { EvalAttempt } from './metrics'
import {
  writeRealReport,
  type RealReportAttempt,
  type RealReportExchangeRecord
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
  const records: RealReportAttempt[] = []
  const exchangeRecords: RealReportExchangeRecord[] = []
  const infrastructureFailures: EvalAttempt[] = []

  attempts: for (const scenario of scenarios) {
    for (let attemptNumber = 1; attemptNumber <= repetitions; attemptNumber += 1) {
      await page.goto(`/?scenario=${scenario.id}`)
      const result = await page.evaluate(async options => {
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

      records.push({ attempt: attemptNumber, result: result.attempt })
      exchangeRecords.push({
        scenarioId: scenario.id,
        attempt: attemptNumber,
        exchanges: result.exchanges
      })
      if (isInfrastructureFailure(result.attempt)) {
        infrastructureFailures.push(result.attempt)
        break attempts
      }
    }
  }

  const files = await writeRealReport(records, {
    runId: createRunId(),
    model,
    repetitions,
    maxRounds,
    scenarioIds: scenarios.map(scenario => scenario.id),
    endpoint,
    browserName,
    browserVersion: browser.version(),
    browserExecutablePath: browser.browserType().executablePath(),
    exchanges: exchangeRecords
  })
  test.info().annotations.push({
    type: '真实模型报告',
    description: files.markdown
  })

  expect(
    infrastructureFailures,
    infrastructureFailures.map(attempt =>
      `${attempt.scenarioId}: ${attempt.failureMessage ?? '未知代理错误'}`
    ).join('\n')
  ).toEqual([])
  expect(records).toHaveLength(scenarios.length * repetitions)
  for (const record of records) {
    expect(record.result).toMatchObject({
      runner: 'legacy',
      model
    })
  }
})

function isInfrastructureFailure(attempt: EvalAttempt): boolean {
  return attempt.failureMessage?.includes('OpenAI-compatible 代理') === true
}

function createRunId(): string {
  return new Date().toISOString().replace(/[-:.]/g, '')
}
