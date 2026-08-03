import { describe, expect, it } from 'vitest'
import type { EvalScenario } from './scenarios'
import {
  isRealInfrastructureFailure,
  runRealEvalMatrix
} from './realEvalRunner'

const scenario: EvalScenario = {
  id: 'read-data',
  category: 'read_data',
  title: '读取数据',
  task: '读取数据',
  expected: '返回数据'
}

describe('runRealEvalMatrix', () => {
  it('第 N+1 个 attempt 抛错时已完成的 N 条仍逐次 checkpoint', async () => {
    const checkpoints: number[] = []
    const progress: string[] = []

    await expect(runRealEvalMatrix({
      scenarios: [scenario],
      repetitions: 3,
      runAttempt: async ({ attemptNumber }) => {
        if (attemptNumber === 3) throw new Error('attempt 3 failed')
        return {
          attempt: {
            scenarioId: scenario.id,
            category: scenario.category,
            runner: 'legacy',
            model: 'test-model',
            passed: true,
            falseSuccess: false,
            durationMs: 10,
            steps: 1
          },
          exchanges: []
        }
      },
      checkpoint: async records => {
        checkpoints.push(records.length)
      },
      onProgress: message => progress.push(message)
    })).rejects.toThrow('attempt 3 failed')

    expect(checkpoints).toEqual([1, 2])
    expect(progress).toEqual([
      'read-data attempt 1/3 checkpointed',
      'read-data attempt 2/3 checkpointed'
    ])
  })

  it('按稳定 marker 识别基础设施失败并在 checkpoint 后停止', async () => {
    let calls = 0
    const checkpoints: number[] = []
    const failureMessage =
      'PAGE_AGENT_EVAL_REAL_INFRASTRUCTURE_ERROR: translated detail'

    const result = await runRealEvalMatrix({
      scenarios: [scenario],
      repetitions: 3,
      runAttempt: async () => {
        calls += 1
        return {
          attempt: {
            scenarioId: scenario.id,
            category: scenario.category,
            runner: 'legacy',
            model: 'test-model',
            passed: false,
            falseSuccess: false,
            durationMs: 10,
            steps: 2,
            failureCode: 'runtime_error',
            failureMessage
          },
          exchanges: []
        }
      },
      checkpoint: async records => {
        checkpoints.push(records.length)
      }
    })

    expect(calls).toBe(1)
    expect(checkpoints).toEqual([1])
    expect(result.infrastructureFailures).toHaveLength(1)
    expect(isRealInfrastructureFailure(result.records[0]?.result)).toBe(true)
    expect(isRealInfrastructureFailure({
      ...result.records[0]?.result,
      failureMessage: 'OpenAI-compatible proxy translated text'
    })).toBe(false)
  })
})
