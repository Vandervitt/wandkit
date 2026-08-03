import { expect, test } from '@playwright/test'
import type { EvalAttempt } from './metrics'
import {
  writeRealReport,
  type RealReportAttempt,
  type RealReportExchangeRecord
} from './report'
import { PAGE_AGENT_SCENARIOS, type EvalScenario } from './scenarios'
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
const SKIP_REASON = '设置 PAGE_AGENT_EVAL_REAL=1 后运行真实模型基线'
const DEFAULT_ENDPOINT = 'http://127.0.0.1:8788/llm/chat'
const DEFAULT_MODEL = 'glm-4-flash'
const DEFAULT_ATTEMPTS = 3
const DEFAULT_MAX_ROUNDS = 20

test(`真实模型网页基线（${SKIP_REASON}）`, async ({
  browser,
  browserName,
  page
}) => {
  test.skip(!REAL_EVAL_ENABLED, SKIP_REASON)
  test.setTimeout(30 * 60_000)

  const endpoint = resolveEndpoint(process.env.PAGE_AGENT_EVAL_REAL_ENDPOINT)
  const model = resolveModel(process.env.PAGE_AGENT_EVAL_REAL_MODEL)
  const repetitions = resolveRepetitions(
    process.env.PAGE_AGENT_EVAL_REAL_ATTEMPTS
  )
  const maxRounds = resolveMaxRounds(
    process.env.PAGE_AGENT_EVAL_REAL_MAX_ROUNDS
  )
  const scenarios = resolveScenarios(
    process.env.PAGE_AGENT_EVAL_REAL_SCENARIOS
  )
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

function resolveEndpoint(configured?: string): string {
  const value = configured?.trim() || DEFAULT_ENDPOINT
  let url: URL
  try {
    url = new URL(value)
  } catch (_error) {
    throw new Error(`PAGE_AGENT_EVAL_REAL_ENDPOINT 不是有效 URL: ${value}`)
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('PAGE_AGENT_EVAL_REAL_ENDPOINT 只允许 http/https')
  }
  if (url.username || url.password) {
    throw new Error('PAGE_AGENT_EVAL_REAL_ENDPOINT 禁止内嵌鉴权信息')
  }
  return url.toString()
}

function resolveModel(configured?: string): string {
  const model = configured?.trim() || process.env.LLM_MODEL?.trim() || DEFAULT_MODEL
  if (model === '') throw new Error('PAGE_AGENT_EVAL_REAL_MODEL 不能为空')
  return model
}

function resolveRepetitions(configured?: string): number {
  return resolvePositiveInteger(
    configured,
    DEFAULT_ATTEMPTS,
    'PAGE_AGENT_EVAL_REAL_ATTEMPTS'
  )
}

function resolveMaxRounds(configured?: string): number {
  return resolvePositiveInteger(
    configured,
    DEFAULT_MAX_ROUNDS,
    'PAGE_AGENT_EVAL_REAL_MAX_ROUNDS'
  )
}

function resolvePositiveInteger(
  configured: string | undefined,
  defaultValue: number,
  variableName: string
): number {
  if (configured === undefined) return defaultValue
  if (!/^[1-9]\d*$/.test(configured)) {
    throw new Error(`${variableName} 必须是正整数`)
  }
  return Number(configured)
}

function resolveScenarios(configured?: string): readonly EvalScenario[] {
  if (configured === undefined || configured.trim() === '') {
    return PAGE_AGENT_SCENARIOS
  }
  const requested = [...new Set(
    configured.split(',').map(item => item.trim()).filter(Boolean)
  )]
  if (requested.length === 0) {
    throw new Error('PAGE_AGENT_EVAL_REAL_SCENARIOS 至少包含一个场景 ID')
  }
  const byId = new Map<string, EvalScenario>(
    PAGE_AGENT_SCENARIOS.map(scenario => [scenario.id, scenario])
  )
  const unknown = requested.filter(id => !byId.has(id))
  if (unknown.length > 0) {
    throw new Error(`PAGE_AGENT_EVAL_REAL_SCENARIOS 包含未知 ID: ${unknown.join(', ')}`)
  }
  return requested.map(id => byId.get(id) as EvalScenario)
}

function isInfrastructureFailure(attempt: EvalAttempt): boolean {
  return attempt.failureCode === 'runtime_error' &&
    attempt.failureMessage?.includes('OpenAI-compatible 代理') === true
}

function createRunId(): string {
  return new Date().toISOString().replace(/[-:.]/g, '')
}
