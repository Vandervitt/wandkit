import type { EvalAttempt, EvalFailureCode } from '../metrics'
import { PAGE_AGENT_SCENARIOS } from '../scenarios'
import { createLegacyDeterministicCase } from './deterministicCases'
import { runLegacyRuntime } from './legacyRuntime'
import { mountScenario, type MountedScenario } from './scenarioRegistry'

declare global {
  interface Window {
    __WANDKIT_SCENARIO__: MountedScenario
    __WANDKIT_EVAL__: {
      runLegacy(scenarioId: string): Promise<EvalAttempt>
    }
  }
}

const app = document.querySelector<HTMLElement>('#app')
if (!app) throw new Error('找不到网页评估站点挂载节点 #app')

const scenarioId =
  new URLSearchParams(window.location.search).get('scenario') ?? 'read-data'

let mountedScenario = mountScenario(scenarioId, app)
window.__WANDKIT_SCENARIO__ = mountedScenario

window.__WANDKIT_EVAL__ = {
  async runLegacy(requestedScenarioId) {
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

    const deterministicCase = createLegacyDeterministicCase(requestedScenarioId)
    const startedAt = performance.now()

    try {
      const result = await runLegacyRuntime({
        task: mountedScenario.task,
        replies: deterministicCase.replies
      })
      const evaluation = mountedScenario.evaluate(result.answer)
      const failureCode = evaluation.passed
        ? undefined
        : deterministicCase.failureCode ?? classifyRuntimeFailure(
          result.status,
          result.stopReason
        )

      return {
        scenarioId: scenario.id,
        category: scenario.category,
        runner: 'legacy',
        passed: evaluation.passed,
        falseSuccess: evaluation.falseSuccess,
        durationMs: Math.round(performance.now() - startedAt),
        steps: result.steps,
        ...(failureCode === undefined ? {} : { failureCode }),
        ...(evaluation.passed ? {} : {
          failureMessage: deterministicCase.failureMessage ??
            result.stopReason ?? '旧 Runtime 结束后页面未满足场景成功判据。'
        })
      }
    } catch (error) {
      return {
        scenarioId: scenario.id,
        category: scenario.category,
        runner: 'legacy',
        passed: false,
        falseSuccess: false,
        durationMs: Math.round(performance.now() - startedAt),
        steps: 0,
        failureCode: 'runtime_error',
        failureMessage: error instanceof Error ? error.message : String(error)
      }
    }
  }
}

function classifyRuntimeFailure(
  status: 'completed' | 'failed' | 'cancelled' | 'awaiting_confirmation',
  stopReason?: string
): EvalFailureCode {
  if (status === 'completed') return 'task_incomplete'
  if (
    stopReason &&
    /(?:model|tool arguments|tool call|JSON|Schema)/i.test(stopReason)
  ) {
    return 'model_protocol'
  }
  return 'runtime_error'
}
