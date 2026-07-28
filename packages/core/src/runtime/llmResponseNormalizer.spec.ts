import { describe, expect, it } from 'vitest'
import type { LlmAssistantMessage } from '../contracts/llm'
import { normalizeLlmAssistantMessage } from './llmResponseNormalizer'

const tools = [{
  type: 'function',
  function: { name: 'cdr_query_v1' }
}]

describe('normalizeLlmAssistantMessage', () => {
  it('将严格的已授权文本工具调用转为标准 tool_calls', () => {
    const result = normalizeLlmAssistantMessage({
      role: 'assistant',
      content: '{"name":"cdr_query_v1","arguments":{"callTimeStart":"2026-07-15 00:00:00"}}'
    }, tools)

    expect(result).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: expect.stringMatching(/^compat_/),
        type: 'function',
        function: {
          name: 'cdr_query_v1',
          arguments: '{"callTimeStart":"2026-07-15 00:00:00"}'
        }
      }]
    })
  })

  it.each([
    ['未授权工具', '{"name":"gateway_delete_v1","arguments":{}}'],
    ['混合自然语言', '请执行 {"name":"cdr_query_v1","arguments":{}}'],
    ['额外顶层字段', '{"name":"cdr_query_v1","arguments":{},"confirm":true}'],
    ['arguments 非对象', '{"name":"cdr_query_v1","arguments":[]}']
  ])('%s 保持为普通文本', (_name, content) => {
    const message: LlmAssistantMessage = { role: 'assistant', content }

    expect(normalizeLlmAssistantMessage(message, tools)).toBe(message)
  })

  it('标准 tool_calls 保持原样', () => {
    const message: LlmAssistantMessage = {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call-1',
        type: 'function',
        function: { name: 'cdr_query_v1', arguments: '{}' }
      }]
    }

    expect(normalizeLlmAssistantMessage(message, tools)).toBe(message)
  })
})
