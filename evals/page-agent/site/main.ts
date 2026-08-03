import type {
  LlmAssistantMessage,
  LlmClient
} from '../../../packages/core/src/index'
import type { EvalAttempt, EvalFailureCode } from '../metrics'
import { PAGE_AGENT_SCENARIOS } from '../scenarios'
import { createLegacyDeterministicCase } from './deterministicCases'
import {
  runLegacyRuntime,
  type LegacyRuntimeResult
} from './legacyRuntime'
import {
  createOpenAICompatibleLlm,
  OPENAI_COMPATIBLE_MAX_ROUNDS_ERROR_CODE,
  type OpenAICompatibleExchange
} from './openAICompatibleLlm'
import { mountScenario, type MountedScenario } from './scenarioRegistry'

declare global {
  interface Window {
    __WANDKIT_SCENARIO__: MountedScenario
  }
}

interface WandkitEvalApi {
  runLegacy(scenarioId: string): Promise<EvalAttempt>
  runLegacyReal(
    scenarioId: string,
    options: { endpoint: string, model: string, maxRounds: number }
  ): Promise<{
    attempt: EvalAttempt
    exchanges: OpenAICompatibleExchange[]
  }>
}

const evalWindow = window as unknown as Window & {
  __WANDKIT_EVAL__: WandkitEvalApi
}

const appNode = document.querySelector<HTMLElement>('#app')
if (!appNode) throw new Error('找不到网页评估站点挂载节点 #app')
const app = appNode

const scenarioId =
  new URLSearchParams(window.location.search).get('scenario') ?? 'read-data'

let mountedScenario = mountScenario(scenarioId, app)
window.__WANDKIT_SCENARIO__ = mountedScenario

evalWindow.__WANDKIT_EVAL__ = {
  async runLegacy(requestedScenarioId) {
    const deterministicCase = createLegacyDeterministicCase(requestedScenarioId)
    return runLegacyEvaluation(requestedScenarioId, {
      replies: deterministicCase.replies
    })
  },

  async runLegacyReal(requestedScenarioId, options) {
    const exchanges: OpenAICompatibleExchange[] = []
    const llm = createOpenAICompatibleLlm({
      endpoint: options.endpoint,
      model: options.model,
      maxRounds: options.maxRounds,
      onExchange: exchange => exchanges.push(exchange)
    })
    const attempt = await runLegacyEvaluation(
      requestedScenarioId,
      { llm },
      options.model
    )
    return { attempt, exchanges }
  }
}

interface LegacyEvaluationRuntime {
  readonly llm?: LlmClient
  readonly replies?: readonly LlmAssistantMessage[]
}

async function runLegacyEvaluation(
  requestedScenarioId: string,
  runtime: LegacyEvaluationRuntime,
  model?: string
): Promise<EvalAttempt> {
  const scenario = PAGE_AGENT_SCENARIOS.find(
    item => item.id === requestedScenarioId
  )
  if (!scenario) throw new Error(`未知网页评估场景: ${requestedScenarioId}`)

  if (mountedScenario.id === requestedScenarioId) {
    mountedScenario.reset()
  } else {
    mountedScenario = mountScenario(requestedScenarioId, app)
    window.__WANDKIT_SCENARIO__ = mountedScenario
  }

  const startedAt = performance.now()
  let result: LegacyRuntimeResult | undefined

  try {
    result = await runLegacyRuntime({
      task: mountedScenario.task,
      ...runtime
    })
    const evaluation = mountedScenario.evaluate(result.answer)
    const failure = evaluation.passed
      ? undefined
      : classifyFailure(
        requestedScenarioId,
        result.status,
        result.stopReason
      )

    return {
      scenarioId: scenario.id,
      category: scenario.category,
      runner: 'legacy',
      ...(model === undefined ? {} : { model }),
      passed: evaluation.passed,
      falseSuccess: evaluation.falseSuccess,
      durationMs: Math.round(performance.now() - startedAt),
      steps: result.steps,
      ...(failure === undefined ? {} : { failureCode: failure.code }),
      ...(evaluation.passed ? {} : {
        failureMessage: failure?.message ??
          '旧 Runtime 结束后页面未满足场景成功判据。'
      })
    }
  } catch (error) {
    return {
      scenarioId: scenario.id,
      category: scenario.category,
      runner: 'legacy',
      ...(model === undefined ? {} : { model }),
      passed: false,
      falseSuccess: false,
      durationMs: Math.round(performance.now() - startedAt),
      steps: result?.steps ?? 0,
      failureCode: 'runtime_error',
      failureMessage: error instanceof Error ? error.message : String(error)
    }
  }
}

interface FailureClassification {
  readonly code: EvalFailureCode
  readonly message: string
}

function classifyFailure(
  scenarioId: string,
  status: LegacyRuntimeResult['status'],
  stopReason?: string
): FailureClassification {
  if (status !== 'completed') {
    if (isProxyInfrastructureFailure(stopReason)) {
      return {
        code: 'runtime_error',
        message: stopReason ?? 'OpenAI-compatible 代理失败。'
      }
    }
    if (isMaxRoundsFailure(stopReason)) {
      return {
        code: 'repeated_action',
        message: stopReason ?? '真实模型超过单次尝试的轮次预算。'
      }
    }
    if (isModelProtocolFailure(stopReason)) {
      return {
        code: 'model_protocol',
        message: stopReason ?? '模型响应未满足旧 Runtime 协议。'
      }
    }
    return {
      code: 'runtime_error',
      message: stopReason ?? `旧 Runtime 以 ${status} 状态结束。`
    }
  }

  const evalRoot = currentScenarioRoot(scenarioId)
  if (scenarioId === 'rich-text') {
    const editorText = evalRoot
      ?.querySelector<HTMLElement>('[contenteditable="true"]')
      ?.textContent
    if (editorText !== '季度总结') {
      return {
        code: 'unsupported_control',
        message: '页面输入动作未写入 contenteditable 富文本正文。'
      }
    }
    if (
      evalRoot?.querySelector('[data-saved-content]')?.textContent !== '季度总结'
    ) {
      return {
        code: 'action_no_effect',
        message: '富文本正文已写入，但保存动作未更新已保存内容。'
      }
    }
  }

  if (scenarioId === 'async-loading') {
    const loadingStatus = evalRoot
      ?.querySelector('[data-log-status]')
      ?.textContent
      ?.trim()
    if (
      loadingStatus === '加载中' ||
      evalRoot?.querySelector('[data-log-total="27"]') === null
    ) {
      return {
        code: 'waiting_timeout',
        message: '旧 Runtime 尝试等待后，操作日志仍未完成异步加载。'
      }
    }
  }

  return {
    code: 'task_incomplete',
    message: '旧 Runtime 结束后页面未满足场景成功判据。'
  }
}

function isModelProtocolFailure(stopReason?: string): boolean {
  if (
    stopReason &&
    /(?:model|tool arguments|tool call|JSON|Schema|LLM replies exhausted)/i
      .test(stopReason)
  ) {
    return true
  }
  return false
}

function isMaxRoundsFailure(stopReason?: string): boolean {
  return stopReason?.includes(OPENAI_COMPATIBLE_MAX_ROUNDS_ERROR_CODE) === true
}

function isProxyInfrastructureFailure(stopReason?: string): boolean {
  return stopReason?.includes('OpenAI-compatible 代理') === true
}

function currentScenarioRoot(scenarioId: string): HTMLElement | null {
  const evalRoot = app.querySelector<HTMLElement>('[data-eval-root]')
  return evalRoot?.dataset.scenario === scenarioId ? evalRoot : null
}
