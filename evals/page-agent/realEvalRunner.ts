import type { EvalAttempt } from './metrics'
import type {
  RealReportAttempt,
  RealReportExchangeRecord
} from './report'
import type { EvalScenario } from './scenarios'
import {
  PAGE_AGENT_EVAL_REAL_INFRASTRUCTURE_ERROR,
  type OpenAICompatibleExchange
} from './site/openAICompatibleLlm'

export interface RealEvalAttemptResult {
  readonly attempt: EvalAttempt
  readonly exchanges: readonly OpenAICompatibleExchange[]
}

export interface RealEvalMatrixOptions {
  readonly scenarios: readonly EvalScenario[]
  readonly repetitions: number
  runAttempt(input: {
    readonly scenario: EvalScenario
    readonly attemptNumber: number
  }): Promise<RealEvalAttemptResult>
  checkpoint(
    records: readonly RealReportAttempt[],
    exchangeRecords: readonly RealReportExchangeRecord[]
  ): Promise<void>
  readonly onProgress?: (message: string) => void
}

export interface RealEvalMatrixResult {
  readonly records: readonly RealReportAttempt[]
  readonly exchangeRecords: readonly RealReportExchangeRecord[]
  readonly infrastructureFailures: readonly EvalAttempt[]
}

export async function runRealEvalMatrix(
  options: RealEvalMatrixOptions
): Promise<RealEvalMatrixResult> {
  const records: RealReportAttempt[] = []
  const exchangeRecords: RealReportExchangeRecord[] = []
  const infrastructureFailures: EvalAttempt[] = []

  attempts: for (const scenario of options.scenarios) {
    for (
      let attemptNumber = 1;
      attemptNumber <= options.repetitions;
      attemptNumber += 1
    ) {
      const result = await options.runAttempt({ scenario, attemptNumber })
      records.push({ attempt: attemptNumber, result: result.attempt })
      exchangeRecords.push({
        scenarioId: scenario.id,
        attempt: attemptNumber,
        exchanges: result.exchanges
      })
      await options.checkpoint([...records], [...exchangeRecords])
      options.onProgress?.(
        `${scenario.id} attempt ${attemptNumber}/${options.repetitions} checkpointed`
      )
      if (isRealInfrastructureFailure(result.attempt)) {
        infrastructureFailures.push(result.attempt)
        break attempts
      }
    }
  }

  return { records, exchangeRecords, infrastructureFailures }
}

export function isRealInfrastructureFailure(
  attempt: EvalAttempt | undefined
): boolean {
  return attempt?.failureMessage?.includes(
    PAGE_AGENT_EVAL_REAL_INFRASTRUCTURE_ERROR
  ) === true
}
