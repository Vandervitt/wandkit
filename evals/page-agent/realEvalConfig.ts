import { PAGE_AGENT_SCENARIOS, type EvalScenario } from './scenarios'

export const REAL_EVAL_SKIP_REASON =
  '设置 PAGE_AGENT_EVAL_REAL=1 后运行真实模型基线'
export const DEFAULT_REAL_EVAL_ENDPOINT =
  'http://127.0.0.1:8788/llm/chat'
export const DEFAULT_REAL_EVAL_MODEL = 'glm-4-flash'
export const DEFAULT_REAL_EVAL_ATTEMPTS = 3
export const DEFAULT_REAL_EVAL_MAX_ROUNDS = 20
export const MAX_REAL_EVAL_ATTEMPTS = 20
export const MAX_REAL_EVAL_ROUNDS = 100

export type RealEvalEnvironment = Readonly<Record<string, string | undefined>>

export interface RealEvalConfig {
  readonly endpoint: string
  readonly model: string
  readonly repetitions: number
  readonly maxRounds: number
  readonly scenarios: readonly EvalScenario[]
}

export function resolveRealEvalConfig(
  env: RealEvalEnvironment
): RealEvalConfig {
  return {
    endpoint: resolveEndpoint(env.PAGE_AGENT_EVAL_REAL_ENDPOINT),
    model: resolveModel(env),
    repetitions: resolvePositiveInteger(
      env.PAGE_AGENT_EVAL_REAL_ATTEMPTS,
      DEFAULT_REAL_EVAL_ATTEMPTS,
      MAX_REAL_EVAL_ATTEMPTS,
      'PAGE_AGENT_EVAL_REAL_ATTEMPTS'
    ),
    maxRounds: resolvePositiveInteger(
      env.PAGE_AGENT_EVAL_REAL_MAX_ROUNDS,
      DEFAULT_REAL_EVAL_MAX_ROUNDS,
      MAX_REAL_EVAL_ROUNDS,
      'PAGE_AGENT_EVAL_REAL_MAX_ROUNDS'
    ),
    scenarios: resolveScenarios(env.PAGE_AGENT_EVAL_REAL_SCENARIOS)
  }
}

function resolveEndpoint(configured?: string): string {
  const value = configured === undefined
    ? DEFAULT_REAL_EVAL_ENDPOINT
    : configured.trim()
  if (value === '') {
    throw new Error('PAGE_AGENT_EVAL_REAL_ENDPOINT 不能为空')
  }

  let url: URL
  try {
    url = new URL(value)
  } catch (_error) {
    throw new Error(`PAGE_AGENT_EVAL_REAL_ENDPOINT 不是有效 URL: ${value}`)
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('PAGE_AGENT_EVAL_REAL_ENDPOINT 只允许 http/https')
  }
  if (!isLoopbackHostname(url.hostname)) {
    throw new Error('PAGE_AGENT_EVAL_REAL_ENDPOINT 只允许 loopback 本机代理')
  }
  if (url.username || url.password) {
    throw new Error('PAGE_AGENT_EVAL_REAL_ENDPOINT 禁止内嵌鉴权信息')
  }
  if (url.search !== '' || url.hash !== '') {
    throw new Error('PAGE_AGENT_EVAL_REAL_ENDPOINT 禁止 query 或 hash')
  }
  if (url.pathname !== '/llm/chat' && url.pathname !== '/llm/chat/') {
    throw new Error('PAGE_AGENT_EVAL_REAL_ENDPOINT path 必须是 /llm/chat')
  }

  url.pathname = '/llm/chat'
  return url.toString()
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  if (normalized === 'localhost' || normalized === '[::1]' || normalized === '::1') {
    return true
  }
  if (!/^127(?:\.\d{1,3}){3}$/.test(normalized)) return false
  return normalized.split('.').every(part => Number(part) <= 255)
}

function resolveModel(env: RealEvalEnvironment): string {
  if (env.PAGE_AGENT_EVAL_REAL_MODEL !== undefined) {
    const configured = env.PAGE_AGENT_EVAL_REAL_MODEL.trim()
    if (configured === '') {
      throw new Error('PAGE_AGENT_EVAL_REAL_MODEL 不能为空')
    }
    return configured
  }
  return env.LLM_MODEL?.trim() || DEFAULT_REAL_EVAL_MODEL
}

function resolvePositiveInteger(
  configured: string | undefined,
  defaultValue: number,
  maximum: number,
  variableName: string
): number {
  if (configured === undefined) return defaultValue
  if (!/^[1-9]\d*$/.test(configured)) {
    throw new Error(`${variableName} 必须是正整数`)
  }
  const value = Number(configured)
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${variableName} 必须是安全整数`)
  }
  if (value > maximum) {
    throw new Error(`${variableName} 不能超过 ${maximum}`)
  }
  return value
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
    throw new Error(
      `PAGE_AGENT_EVAL_REAL_SCENARIOS 包含未知 ID: ${unknown.join(', ')}`
    )
  }
  return requested.map(id => byId.get(id) as EvalScenario)
}
