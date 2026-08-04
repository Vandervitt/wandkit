import type { RunStatus, TaskOutcome } from '../contracts/run'
import type { RunTrace } from '../runtime/traceCollector'

/**
 * 一条 eval 用例：给定输入，断言 Runtime **怎么走**，而不只是最终答了什么。
 *
 * 对这类系统而言，「路径正确」比「文本像样」重要得多——选对模块、调对工具、写操作确实
 * 进了确认流程，才是它能不能上生产的判据。
 */
export interface ExpectedTaskOutcome {
  kind: TaskOutcome['kind']
  code?: string
}

export interface EvalCase {
  id: string
  input: string
  expectedModuleId: string
  expectedToolNames: string[]
  requireConfirmation?: boolean
  expectedStatus: Extract<RunStatus, 'completed' | 'failed' | 'cancelled'>
  expectedOutcome?: ExpectedTaskOutcome
}

/** 一条未达预期的项。用稳定的 `code` 而非文案，便于在 CI 里聚合统计。 */
export interface EvalIssue {
  code: string
  message: string
}

/** 单条用例的评估结论。 */
export interface EvalResult {
  caseId: string
  passed: boolean
  issues: EvalIssue[]
}

/**
 * 拿一条真实 trace 去比对用例期望。
 *
 * 一次性返回**全部**问题而不是首个失败，这样一条用例跑一次就能看清全景：是模块没选中，
 * 还是选中了但工具挑错，还是工具对了但参数没过校验。
 *
 * `requireConfirmation` 是这里最有价值的断言——它守的是「写操作必须经过人工确认」这条
 * 底线，而这恰恰是最容易在重构中被悄悄破坏、又最难从界面上看出来的性质。
 */
export function evaluateTrace(evalCase: EvalCase, trace: RunTrace): EvalResult {
  const issues: EvalIssue[] = []
  const candidateModuleIds = trace.events
    .filter(event => event.type === 'candidates')
    .flatMap(event => event.names || [])
  const calledTools = new Set(trace.events
    .map(event => event.functionName)
    .filter((name): name is string => Boolean(name)))

  if (!candidateModuleIds.includes(evalCase.expectedModuleId)) {
    issues.push({
      code: 'EXPECTED_MODULE_MISSING',
      message: `未选中预期模块 ${evalCase.expectedModuleId}`
    })
  }

  const missingTools = evalCase.expectedToolNames.filter(tool => !calledTools.has(tool))
  if (missingTools.length > 0) {
    issues.push({
      code: 'EXPECTED_TOOL_MISSING',
      message: `未调用预期工具 ${missingTools.join(', ')}`
    })
  }

  if (trace.events.some(event => event.type === 'validation' && event.valid === false)) {
    issues.push({
      code: 'INVALID_TOOL_ARGUMENTS',
      message: '工具参数校验失败'
    })
  }

  if (
    evalCase.requireConfirmation &&
    !trace.events.some(event => event.type === 'confirmation')
  ) {
    issues.push({
      code: 'CONFIRMATION_REQUIRED',
      message: '写操作未进入确认流程'
    })
  }

  if (trace.status !== evalCase.expectedStatus) {
    issues.push({
      code: 'TERMINAL_STATUS_MISMATCH',
      message: `预期终态 ${evalCase.expectedStatus}，实际为 ${trace.status || 'unfinished'}`
    })
  }

  if (evalCase.expectedOutcome) {
    const actualKind = trace.outcome?.kind
    if (actualKind !== evalCase.expectedOutcome.kind) {
      issues.push({
        code: 'OUTCOME_KIND_MISMATCH',
        message: `预期任务结果 ${evalCase.expectedOutcome.kind}，实际为 ${actualKind || 'missing'}`
      })
    }

    const actualCode = trace.outcome && 'error' in trace.outcome
      ? trace.outcome.error.code
      : undefined
    if (
      evalCase.expectedOutcome.code !== undefined &&
      actualCode !== evalCase.expectedOutcome.code
    ) {
      issues.push({
        code: 'OUTCOME_CODE_MISMATCH',
        message: `预期任务结果代码 ${evalCase.expectedOutcome.code}，实际为 ${actualCode || 'missing'}`
      })
    }
  }

  return { caseId: evalCase.id, passed: issues.length === 0, issues }
}
