import { describe, expect, it } from 'vitest'
import { executionFailureResult, invalidInputResult } from './resultNormalizer'
import { defaultMessages } from '../config/messages'

describe('resultNormalizer safety boundary', () => {
  it('非受控执行异常不暴露原始 message', () => {
    const result = executionFailureResult(new Error('Axios 500: jdbc://secret-host'))

    expect(result).toEqual({ ok: false, message: defaultMessages.executionFailure })
    expect(JSON.stringify(result)).not.toContain('secret-host')
  })

  it('Argument validation failed归一为业务化中文，不泄漏 Ajv 字段路径', () => {
    expect(invalidInputResult(new Error('Argument validation failed：data.port must be number'))).toEqual({
      ok: false,
      message: defaultMessages.invalidInput
    })
    expect(JSON.stringify(invalidInputResult(new Error('data.gatewayId')))).not.toContain('gatewayId')
  })
})
