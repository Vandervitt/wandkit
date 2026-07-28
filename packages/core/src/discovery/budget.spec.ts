import { describe, expect, it } from 'vitest'
import type { LlmMessage } from '../contracts/llm'
import {
  applyMessageBudget,
  MAX_CANDIDATE_MODULES,
  MAX_EXPOSED_TOOLS,
  MAX_PROMPT_CHARS,
  selectToolsWithinBudget
} from './budget'

describe('工具预算', () => {
  it('集中声明候选模块、工具和 Prompt 上限', () => {
    expect(MAX_CANDIDATE_MODULES).toBe(2)
    expect(MAX_EXPOSED_TOOLS).toBe(12)
    expect(MAX_PROMPT_CHARS).toBe(24000)
  })

  it('按模块轮询选择工具，避免首个模块挤占全部预算', () => {
    expect(selectToolsWithinBudget([
      ['gateway-1', 'gateway-2', 'gateway-3'],
      ['cdr-1', 'cdr-2']
    ], 4)).toEqual(['gateway-1', 'cdr-1', 'gateway-2', 'cdr-2'])
  })
})

describe('Prompt 预算', () => {
  it('优先保留系统指令、当前用户输入和最近历史', () => {
    const messages: LlmMessage[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'old-user-xxxxxxxxxx' },
      { role: 'assistant', content: 'old-answer-xxxxxxxxxx' },
      { role: 'user', content: 'current-user' }
    ]

    expect(applyMessageBudget(messages, 40)).toEqual([
      { role: 'system', content: 'system' },
      { role: 'assistant', content: 'old-answer-xxxxxxxxxx' },
      { role: 'user', content: 'current-user' }
    ])
  })

  it('工具调用与结果作为原子组，预算不足时整组舍弃', () => {
    const messages: LlmMessage[] = [
      { role: 'system', content: 'system' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call-1',
          type: 'function',
          function: { name: 'query', arguments: '{"keyword":"very-long"}' }
        }]
      },
      { role: 'tool', tool_call_id: 'call-1', content: 'tool-result' },
      { role: 'user', content: 'current-user' }
    ]

    expect(applyMessageBudget(messages, 25)).toEqual([
      { role: 'system', content: 'system' },
      { role: 'user', content: 'current-user' }
    ])
  })
})
