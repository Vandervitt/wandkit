import { describe, expect, it } from 'vitest'
import { ConversationStore } from './conversationStore'
import { FakeLlm } from '../testing/fakeLlm'
import type { LlmAssistantMessage, LlmToolCall } from '../contracts/llm'

const deleteCall: LlmToolCall = {
  id: 'call-delete-1',
  type: 'function',
  function: {
    name: 'gateway_delete_v1',
    arguments: '{"gatewayId":"1"}'
  }
}

function firstToolCall(message: LlmAssistantMessage): LlmToolCall {
  const call = message.tool_calls?.[0]
  if (!call) throw new Error('测试消息缺少工具调用')
  return call
}

describe('ConversationStore', () => {
  it('回滚到安全点时移除未完成的工具调用', () => {
    const history = new ConversationStore()
    history.push({ role: 'user', content: '删除线路 1' })
    history.markSafePoint()
    history.push({ role: 'assistant', content: null, tool_calls: [deleteCall] })

    history.rollbackToSafePoint()

    expect(history.messages).toEqual([
      { role: 'user', content: '删除线路 1' }
    ])
  })

  it('只在工具真实完成后追加结果消息', () => {
    const history = new ConversationStore()
    history.push({ role: 'assistant', content: null, tool_calls: [deleteCall] })

    expect(history.messages).toHaveLength(1)
    expect(history.messages.some(message => message.role === 'tool')).toBe(false)

    history.appendToolResult(deleteCall.id, {
      ok: true,
      message: '删除成功'
    })

    expect(history.messages[1]).toEqual({
      role: 'tool',
      tool_call_id: deleteCall.id,
      content: JSON.stringify({ ok: true, message: '删除成功' })
    })
  })

  it('写入模型历史时通用剔除 uiEffect 但保留消息和安全数据', () => {
    const history = new ConversationStore()
    const result = {
      ok: true,
      message: '已查询 1 条话单',
      data: {
        query: { phone: '138****8000' },
        rows: [{ phone: '138****8000' }],
        total: 1
      },
      uiEffect: {
        type: 'cdr:show-query',
        payload: {
          query: { phone: '13800138000' },
          rows: [{ phone: '138****8000' }],
          total: 1
        }
      }
    }

    history.appendToolResult('call-cdr-1', result)

    const toolMessage = history.messages[0]
    expect(toolMessage).toMatchObject({ role: 'tool', tool_call_id: 'call-cdr-1' })
    if (toolMessage.role !== 'tool') throw new Error('期望工具消息')
    expect(JSON.parse(toolMessage.content)).toEqual({
      ok: true,
      message: '已查询 1 条话单',
      data: {
        query: { phone: '138****8000' },
        rows: [{ phone: '138****8000' }],
        total: 1
      }
    })
    expect(toolMessage.content).not.toContain('13800138000')
    expect(result.uiEffect.payload.query.phone).toBe('13800138000')
  })

  it('清空消息和已标记的安全点', () => {
    const history = new ConversationStore()
    history.push({ role: 'user', content: '查询线路' })
    history.markSafePoint()
    history.clear()
    history.push({ role: 'user', content: '新对话' })
    history.rollbackToSafePoint()

    expect(history.messages).toEqual([{ role: 'user', content: '新对话' }])
  })

  it('写入和读取都不暴露历史消息的可变引用', () => {
    const history = new ConversationStore()
    const source: LlmAssistantMessage = {
      role: 'assistant',
      content: null,
      tool_calls: [{
        ...deleteCall,
        function: { ...deleteCall.function }
      }]
    }
    history.push(source)

    firstToolCall(source).function.name = 'changed_from_source'
    const read = history.messages[0] as LlmAssistantMessage
    firstToolCall(read).function.name = 'changed_from_read'

    expect(history.messages).toEqual([{
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call-delete-1',
        type: 'function',
        function: {
          name: 'gateway_delete_v1',
          arguments: '{"gatewayId":"1"}'
        }
      }]
    }])
  })

  it('深拷贝保留空内容和显式 undefined 字段', () => {
    const history = new ConversationStore()
    history.push({ role: 'assistant', content: '', tool_calls: undefined })

    expect(history.messages).toEqual([
      { role: 'assistant', content: '', tool_calls: undefined }
    ])
  })
})

describe('FakeLlm', () => {
  it('按脚本返回消息并记录请求快照', async() => {
    const reply: LlmAssistantMessage = {
      role: 'assistant',
      content: '已完成'
    }
    const fake = new FakeLlm([reply])
    const messages = [{ role: 'user' as const, content: '查询线路' }]
    const tools = [{ type: 'function' }]

    await expect(fake.chat(messages, tools)).resolves.toEqual(reply)
    expect(fake.requests).toEqual([{ messages, tools }])
  })

  it('脚本耗尽时显式失败', async() => {
    const fake = new FakeLlm([])

    await expect(fake.chat([], [])).rejects.toThrow('Fake LLM reply exhausted')
  })

  it('记录消息和工具的深快照', async() => {
    const fake = new FakeLlm([{ role: 'assistant', content: '已完成' }])
    const messages: LlmAssistantMessage[] = [{
      role: 'assistant',
      content: null,
      tool_calls: [{
        ...deleteCall,
        function: { ...deleteCall.function }
      }]
    }]
    const tools = [{
      function: {
        name: 'gateway_delete_v1'
      }
    }]

    await fake.chat(messages, tools)
    firstToolCall(messages[0]).function.name = 'changed_message'
    tools[0].function.name = 'changed_tool'

    expect(fake.requests[0].messages).toEqual([{
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call-delete-1',
        type: 'function',
        function: {
          name: 'gateway_delete_v1',
          arguments: '{"gatewayId":"1"}'
        }
      }]
    }])
    expect(fake.requests[0].tools).toEqual([
      {
        function: {
          name: 'gateway_delete_v1'
        }
      }
    ])
  })

  it('调用时 signal 已中止则抛出 AbortError', async() => {
    const fake = new FakeLlm([{ role: 'assistant', content: '不应返回' }])
    const controller = new AbortController()
    controller.abort()

    await expect(fake.chat([], [], controller.signal)).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(fake.requests).toHaveLength(0)
  })
})
