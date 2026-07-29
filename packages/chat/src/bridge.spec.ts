/**
 * 桥接层：把核心运行时的 UI 事件翻译成会话状态。
 *
 * 它是**可选**的——会话本身不依赖 `toolairlock`，这层只在接入方确实用了核心运行时
 * 时才引入。因此这里用最小的鸭子类型描述运行时，不 import 核心包。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatSession } from './session'
import { connectRuntime, type RuntimeLike, type RuntimeUiEventLike } from './bridge'

function createRuntime() {
  const handlers: Array<(event: RuntimeUiEventLike) => void> = []
  const runtime: RuntimeLike & {
    emit(event: RuntimeUiEventLike): void
    started: string[]
    confirmed: string[]
    cancelled: string[]
  } = {
    started: [],
    confirmed: [],
    cancelled: [],
    start: vi.fn(async (input: string) => { runtime.started.push(input) }) as never,
    confirm: vi.fn(async (id: string) => { runtime.confirmed.push(id) }) as never,
    cancel: vi.fn(async (id: string) => { runtime.cancelled.push(id) }) as never,
    stop: vi.fn(),
    emit(event) { handlers.forEach(handler => handler(event)) }
  }
  return { runtime, onEvent: (h: (e: RuntimeUiEventLike) => void) => handlers.push(h) }
}

let session: ChatSession
beforeEach(() => {
  session = new ChatSession()
})

describe('运行时事件 → 会话状态', () => {
  it('assistant 事件落成一条消息', () => {
    const { runtime, onEvent } = createRuntime()
    connectRuntime(session, runtime, { onEvent })

    runtime.emit({ type: 'assistant', content: '共 2 条' })

    expect(session.state.entries.map(e => e.content)).toEqual(['共 2 条'])
  })

  it('工具调用轮次的 content 为 null 时不产生空气泡', () => {
    // 运行时在有工具调用的轮次会传 null——那通常是思维链，不该展示。
    const { runtime, onEvent } = createRuntime()
    connectRuntime(session, runtime, { onEvent })

    runtime.emit({ type: 'assistant', content: null })

    expect(session.state.entries).toHaveLength(0)
  })

  it('导出的历史里 tool 消息必须有发起它的 assistant 调用', () => {
    // 真实页面实测的缺陷：运行时在工具调用轮次传 content: null，桥接层据此跳过，
    // 结果那一轮的 tool_calls 也一起丢了。导出的历史里 tool 消息成了孤儿——
    // 这在 OpenAI 协议下非法，厂商会拒绝整条会话。
    const { runtime, onEvent } = createRuntime()
    connectRuntime(session, runtime, { onEvent })

    runtime.emit({
      type: 'assistant',
      content: null,
      toolCalls: [{
        id: 'c1', type: 'function',
        function: { name: 'page_read_v1', arguments: '{}' }
      }]
    })
    runtime.emit({
      type: 'tool_result',
      toolCallId: 'c1',
      result: { ok: true, message: '已读取' }
    })

    const messages = session.toMessages()
    expect(messages[0]).toMatchObject({
      role: 'assistant',
      tool_calls: [{ id: 'c1' }]
    })
    expect(messages[1]).toMatchObject({ role: 'tool', tool_call_id: 'c1' })
  })

  it('带工具调用的轮次不产生空气泡，但工具名可见', () => {
    const { runtime, onEvent } = createRuntime()
    connectRuntime(session, runtime, { onEvent })

    runtime.emit({
      type: 'assistant',
      content: null,
      toolCalls: [{
        id: 'c1', type: 'function', function: { name: 'page_read_v1', arguments: '{}' }
      }]
    })

    const entry = session.state.entries[0]
    expect(entry.content).toBe('')
    expect(entry.toolCalls?.[0].function.name).toBe('page_read_v1')
  })

  it('tool_result 事件带上成败标记', () => {
    const { runtime, onEvent } = createRuntime()
    connectRuntime(session, runtime, { onEvent })

    runtime.emit({
      type: 'tool_result',
      toolCallId: 'c1',
      result: { ok: false, message: '目标不存在' }
    })

    expect(session.state.entries[0]).toMatchObject({
      role: 'tool', toolCallId: 'c1', ok: false, content: '目标不存在'
    })
  })

  it('confirmation 事件挂起会话', () => {
    const { runtime, onEvent } = createRuntime()
    connectRuntime(session, runtime, { onEvent })

    runtime.emit({
      type: 'confirmation',
      confirmation: {
        confirmationId: 'run-1:c1', toolCallId: 'c1', functionName: 'del',
        title: '确认删除', rows: [{ label: '用户', value: '张三' }], risk: 'destructive'
      }
    })

    expect(session.state.status).toBe('awaiting_confirmation')
    expect(session.state.confirmation?.title).toBe('确认删除')
  })

  it('rawRequest 原样透传给确认卡片', () => {
    // 它是卡片上唯一不可能撒谎的部分，丢了等于把治理的披露环节削掉一半。
    const { runtime, onEvent } = createRuntime()
    connectRuntime(session, runtime, { onEvent })

    runtime.emit({
      type: 'confirmation',
      confirmation: {
        confirmationId: 'a', toolCallId: 'b', functionName: 'f',
        title: 't', rows: [], risk: 'write',
        rawRequest: { method: 'DELETE', url: '/api/users/u_1' }
      }
    })

    expect(session.state.confirmation?.rawRequest)
      .toEqual({ method: 'DELETE', url: '/api/users/u_1' })
  })

  it('终态事件把会话交还给用户', () => {
    const { runtime, onEvent } = createRuntime()
    connectRuntime(session, runtime, { onEvent })
    session.appendUser('查询')

    runtime.emit({ type: 'state', snapshot: { runId: 'r', traceId: 't', status: 'completed' } })

    expect(session.state.status).toBe('idle')
  })

  it('执行中的状态保持 busy', () => {
    const { runtime, onEvent } = createRuntime()
    connectRuntime(session, runtime, { onEvent })

    runtime.emit({ type: 'state', snapshot: { runId: 'r', traceId: 't', status: 'thinking' } })

    expect(session.state.status).toBe('busy')
  })

  it('失败终态带出停止原因', () => {
    const { runtime, onEvent } = createRuntime()
    connectRuntime(session, runtime, { onEvent })

    runtime.emit({
      type: 'state',
      snapshot: { runId: 'r', traceId: 't', status: 'failed' },
      stopReason: '达到最大轮次'
    })

    expect(session.state.error).toBe('达到最大轮次')
  })

  it('clear 事件清空会话', () => {
    const { runtime, onEvent } = createRuntime()
    connectRuntime(session, runtime, { onEvent })
    session.appendUser('x')

    runtime.emit({ type: 'clear' })

    expect(session.state.entries).toHaveLength(0)
  })
})

describe('会话动作 → 运行时', () => {
  it('send 把输入同时写进会话与运行时', async () => {
    const { runtime, onEvent } = createRuntime()
    const controls = connectRuntime(session, runtime, { onEvent })

    await controls.send('把张三删掉')

    expect(session.state.entries[0].content).toBe('把张三删掉')
    expect(runtime.started).toEqual(['把张三删掉'])
  })

  it('批准确认时调用运行时的 confirm', async () => {
    const { runtime, onEvent } = createRuntime()
    const controls = connectRuntime(session, runtime, { onEvent })
    runtime.emit({
      type: 'confirmation',
      confirmation: {
        confirmationId: 'run-1:c1', toolCallId: 'c1', functionName: 'f',
        title: 't', rows: [], risk: 'write'
      }
    })

    await controls.approve('run-1:c1')

    expect(runtime.confirmed).toEqual(['run-1:c1'])
    expect(session.state.confirmation).toBeUndefined()
  })

  it('拒绝确认时调用运行时的 cancel', async () => {
    const { runtime, onEvent } = createRuntime()
    const controls = connectRuntime(session, runtime, { onEvent })
    runtime.emit({
      type: 'confirmation',
      confirmation: {
        confirmationId: 'run-1:c1', toolCallId: 'c1', functionName: 'f',
        title: 't', rows: [], risk: 'write'
      }
    })

    await controls.reject('run-1:c1')

    expect(runtime.cancelled).toEqual(['run-1:c1'])
  })

  it('过期的确认 ID 不会打到运行时上', async () => {
    // 上一个 Run 遗留的卡片回传过期 ID，放行它等于用旧的同意批准当前写入。
    const { runtime, onEvent } = createRuntime()
    const controls = connectRuntime(session, runtime, { onEvent })
    runtime.emit({
      type: 'confirmation',
      confirmation: {
        confirmationId: 'run-1:c1', toolCallId: 'c1', functionName: 'f',
        title: 't', rows: [], risk: 'write'
      }
    })

    await controls.approve('过期的ID')

    expect(runtime.confirmed).toEqual([])
    expect(session.state.confirmation?.confirmationId).toBe('run-1:c1')
  })

  it('运行时抛错时会话记录错误而不是卡死', async () => {
    const { runtime, onEvent } = createRuntime()
    runtime.start = vi.fn(async () => { throw new Error('当前 Run 正在执行') }) as never
    const controls = connectRuntime(session, runtime, { onEvent })

    await controls.send('x')

    expect(session.state.status).toBe('idle')
    expect(session.state.error).toContain('当前 Run 正在执行')
  })

  it('dispose 后不再接收事件', () => {
    const { runtime, onEvent } = createRuntime()
    const controls = connectRuntime(session, runtime, { onEvent })
    controls.dispose()

    runtime.emit({ type: 'assistant', content: '应被忽略' })

    expect(session.state.entries).toHaveLength(0)
  })
})
