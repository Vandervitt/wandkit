import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatSession } from './session'
import type { ChatCompletionChunk } from './protocol'

let clock = 0
function createSession(): ChatSession {
  clock = 0
  return new ChatSession({ now: () => ++clock })
}

function chunk(delta: ChatCompletionChunk['choices'][0]['delta'], finish?: string) {
  return { choices: [{ delta, finish_reason: finish ?? null }] }
}

let session: ChatSession
beforeEach(() => {
  session = createSession()
})

describe('完整消息', () => {
  it('追加用户消息后进入 busy——界面据此禁用输入', () => {
    session.appendUser('把张三删掉')

    expect(session.state.entries.map(e => ({ role: e.role, content: e.content })))
      .toEqual([{ role: 'user', content: '把张三删掉' }])
    expect(session.state.status).toBe('busy')
  })

  it('追加 assistant 回复后回到 idle', () => {
    session.appendUser('查询')
    session.append({ role: 'assistant', content: '共 2 条' })

    expect(session.state.entries[1].content).toBe('共 2 条')
    expect(session.state.status).toBe('idle')
  })

  it('system 消息不进入展示——它是给模型的，不是给人的', () => {
    session.append({ role: 'system', content: '你是一个助手' })

    expect(session.state.entries).toHaveLength(0)
  })

  it('assistant 的工具调用被保留，供界面显示「正在做什么」', () => {
    session.append({
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'c1', type: 'function',
        function: { name: 'user_delete_v1', arguments: '{"id":"u_1"}' }
      }]
    })

    expect(session.state.entries[0].toolCalls?.[0].function.name).toBe('user_delete_v1')
    expect(session.state.status).toBe('busy')
  })

  it('tool 结果按 ok 标记成败', () => {
    session.append({
      role: 'tool', tool_call_id: 'c1',
      content: JSON.stringify({ ok: false, message: '目标不存在' })
    })

    expect(session.state.entries[0]).toMatchObject({
      role: 'tool', toolCallId: 'c1', ok: false, content: '目标不存在'
    })
  })

  it('非 JSON 的 tool 内容原样展示，不崩', () => {
    session.append({ role: 'tool', tool_call_id: 'c1', content: '纯文本结果' })

    expect(session.state.entries[0].content).toBe('纯文本结果')
    expect(session.state.entries[0].ok).toBeUndefined()
  })
})

describe('流式增量', () => {
  it('逐块累积文本，期间标记 streaming', () => {
    session.applyChunk(chunk({ role: 'assistant', content: '共 ' }))
    expect(session.state.entries[0].streaming).toBe(true)

    session.applyChunk(chunk({ content: '2 ' }))
    session.applyChunk(chunk({ content: '条' }))

    expect(session.state.entries[0].content).toBe('共 2 条')
  })

  it('finish_reason 到达即结束流式，回到 idle', () => {
    session.applyChunk(chunk({ role: 'assistant', content: '完成' }))
    session.applyChunk(chunk({}, 'stop'))

    expect(session.state.entries[0].streaming).toBeFalsy()
    expect(session.state.status).toBe('idle')
  })

  it('多个 chunk 合成一条消息，而不是多条', () => {
    session.applyChunk(chunk({ role: 'assistant', content: 'a' }))
    session.applyChunk(chunk({ content: 'b' }))

    expect(session.state.entries).toHaveLength(1)
  })

  it('按 index 归位并行的工具调用碎片', () => {
    // id 与 name 只在首个片段出现，后续仅带 arguments 的一小段——没有 index 就
    // 无法把碎片放回正确的调用上。
    session.applyChunk(chunk({
      tool_calls: [
        { index: 0, id: 'c1', type: 'function', function: { name: 'query', arguments: '{"a' } },
        { index: 1, id: 'c2', type: 'function', function: { name: 'del', arguments: '{"b' } }
      ]
    }))
    session.applyChunk(chunk({
      tool_calls: [
        { index: 1, function: { arguments: '":2}' } },
        { index: 0, function: { arguments: '":1}' } }
      ]
    }))

    expect(session.state.entries[0].toolCalls).toEqual([
      { id: 'c1', type: 'function', function: { name: 'query', arguments: '{"a":1}' } },
      { id: 'c2', type: 'function', function: { name: 'del', arguments: '{"b":2}' } }
    ])
  })

  it('乱序到达的 index 也能正确归位', () => {
    session.applyChunk(chunk({
      tool_calls: [{ index: 2, id: 'c3', type: 'function', function: { name: 'z', arguments: '{}' } }]
    }))

    expect(session.state.entries[0].toolCalls).toHaveLength(1)
    expect(session.state.entries[0].toolCalls?.[0].id).toBe('c3')
  })

  it('流式结束后再来新消息会另起一条', () => {
    session.applyChunk(chunk({ role: 'assistant', content: '第一条' }))
    session.applyChunk(chunk({}, 'stop'))
    session.applyChunk(chunk({ role: 'assistant', content: '第二条' }))

    expect(session.state.entries.map(e => e.content)).toEqual(['第一条', '第二条'])
  })

  it('空 choices 的心跳块被安全忽略', () => {
    expect(() => session.applyChunk({ choices: [] })).not.toThrow()
    expect(session.state.entries).toHaveLength(0)
  })
})

describe('导出为 OpenAI 消息', () => {
  it('原样吐回标准形状，可直接喂给下一轮请求', () => {
    session.append({ role: 'system', content: 'sys' })
    session.appendUser('删除用户')
    session.append({
      role: 'assistant', content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'del', arguments: '{}' } }]
    })
    session.append({ role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' })

    expect(session.toMessages()).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: '删除用户' },
      {
        role: 'assistant', content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'del', arguments: '{}' } }]
      },
      { role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' }
    ])
  })

  it('流式拼出的消息同样能导出为完整消息', () => {
    session.applyChunk(chunk({ role: 'assistant', content: '好的' }))
    session.applyChunk(chunk({}, 'stop'))

    expect(session.toMessages()).toEqual([{ role: 'assistant', content: '好的' }])
  })

  it('导出的是拷贝，改它不影响会话', () => {
    session.appendUser('x')
    const messages = session.toMessages()
    ;(messages[0] as { content: string }).content = '篡改'

    expect(session.toMessages()[0]).toMatchObject({ content: 'x' })
  })
})

describe('确认流程', () => {
  const confirmation = {
    confirmationId: 'run-1:c1',
    toolCallId: 'c1',
    functionName: 'user_delete_v1',
    title: '确认删除用户',
    rows: [{ label: '用户', value: '张三' }],
    risk: 'destructive' as const
  }

  it('挂起确认时状态切到 awaiting_confirmation', () => {
    session.requestConfirmation(confirmation)

    expect(session.state.status).toBe('awaiting_confirmation')
    expect(session.state.confirmation?.title).toBe('确认删除用户')
  })

  it('批准后清空待确认项并回到 busy——写入还在执行', () => {
    session.requestConfirmation(confirmation)
    const decision = session.resolveConfirmation('run-1:c1', 'approve')

    expect(decision).toBe(true)
    expect(session.state.confirmation).toBeUndefined()
    expect(session.state.status).toBe('busy')
  })

  it('拒绝同样清空待确认项', () => {
    session.requestConfirmation(confirmation)
    session.resolveConfirmation('run-1:c1', 'reject')

    expect(session.state.confirmation).toBeUndefined()
  })

  it('ID 不匹配时拒绝处理——过期卡片不得批准当前操作', () => {
    // 上一个 Run 遗留在屏幕上的确认框回传的是一个已不当前的 ID。
    session.requestConfirmation(confirmation)
    const decision = session.resolveConfirmation('过期的ID', 'approve')

    expect(decision).toBe(false)
    expect(session.state.confirmation?.confirmationId).toBe('run-1:c1')
  })
})

describe('订阅与快照', () => {
  it('状态变化时通知订阅者', () => {
    const listener = vi.fn()
    session.subscribe(listener)

    session.appendUser('x')

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('退订后不再通知', () => {
    const listener = vi.fn()
    const unsubscribe = session.subscribe(listener)
    unsubscribe()

    session.appendUser('x')

    expect(listener).not.toHaveBeenCalled()
  })

  it('订阅者抛错不影响其他订阅者与会话本身', () => {
    const good = vi.fn()
    session.subscribe(() => { throw new Error('boom') })
    session.subscribe(good)

    expect(() => session.appendUser('x')).not.toThrow()
    expect(good).toHaveBeenCalled()
  })

  it('state 每次返回新引用，便于框架做浅比较', () => {
    const before = session.state
    session.appendUser('x')

    expect(session.state).not.toBe(before)
  })
})

describe('错误与清空', () => {
  it('报错时回到 idle 并记录文案', () => {
    session.appendUser('x')
    session.fail('网络异常，请稍后重试')

    expect(session.state.status).toBe('idle')
    expect(session.state.error).toBe('网络异常，请稍后重试')
  })

  it('新一轮输入会清掉上次的错误', () => {
    session.fail('旧错误')
    session.appendUser('再试一次')

    expect(session.state.error).toBeUndefined()
  })

  it('clear 重置为初始状态', () => {
    session.appendUser('x')
    session.requestConfirmation({
      confirmationId: 'a', toolCallId: 'b', functionName: 'f',
      title: 't', rows: [], risk: 'write'
    })
    session.clear()

    expect(session.state).toMatchObject({ entries: [], status: 'idle' })
    expect(session.state.confirmation).toBeUndefined()
  })
})
