import { describe, expect, it } from 'vitest'
import type { RunTrace } from '../runtime/traceCollector'
import { evaluateTrace } from './evalSuite'

function createTrace(overrides: Partial<RunTrace> = {}): RunTrace {
  return {
    runId: 'run-1',
    traceId: 'trace-1',
    inputSummary: '[redacted:length=4]',
    startedAt: 1,
    endedAt: 2,
    status: 'completed',
    events: [],
    ...overrides
  }
}

describe('Trace Eval', () => {
  it('模块、工具、参数校验、确认和终态符合预期时通过', () => {
    const result = evaluateTrace({
      id: 'gateway-update',
      input: '更新线路',
      expectedModuleId: 'gateway',
      expectedToolNames: ['gateway_update_v1'],
      requireConfirmation: true,
      expectedStatus: 'completed'
    }, createTrace({
      events: [
        { type: 'candidates', names: ['gateway'] },
        { type: 'validation', functionName: 'gateway_update_v1', valid: true },
        { type: 'confirmation', functionName: 'gateway_update_v1', decision: 'approved' },
        { type: 'tool_succeeded', functionName: 'gateway_update_v1' }
      ]
    }))

    expect(result).toEqual({ caseId: 'gateway-update', passed: true, issues: [] })
  })

  it('一次返回可维护的结构化回退原因', () => {
    const result = evaluateTrace({
      id: 'cdr-detail',
      input: '查看第一条话单详情',
      expectedModuleId: 'cdr',
      expectedToolNames: ['cdr_detail_v1'],
      expectedStatus: 'completed'
    }, createTrace({
      status: 'failed',
      events: [
        { type: 'candidates', names: ['gateway'] },
        { type: 'validation', functionName: 'gateway_query_v1', valid: false },
        { type: 'tool_succeeded', functionName: 'gateway_query_v1' }
      ]
    }))

    expect(result.issues.map(issue => issue.code)).toEqual([
      'EXPECTED_MODULE_MISSING',
      'EXPECTED_TOOL_MISSING',
      'INVALID_TOOL_ARGUMENTS',
      'TERMINAL_STATUS_MISMATCH'
    ])
  })
})
