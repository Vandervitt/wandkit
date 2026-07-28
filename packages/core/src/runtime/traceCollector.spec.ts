import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TRACE_STORAGE_KEY,
  TraceCollector,
  type TraceStorage
} from './traceCollector'

function createStorage(initial: Record<string, string> = {}): TraceStorage & {
  values: Map<string, string>
} {
  const values = new Map(Object.entries(initial))
  return {
    values,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) }
  }
}

describe('TraceCollector', () => {
  it('记录成功、失败和取消的闭合 Run', () => {
    const traces = new TraceCollector()

    traces.start('run-success', 'trace-success', '查询线路')
    traces.record('run-success', { type: 'candidates', names: ['gateway'] })
    traces.finish('run-success', 'completed')
    traces.start('run-failed', 'trace-failed', '更新线路')
    traces.record('run-failed', { type: 'tool_failed', functionName: 'gateway_update_v1' })
    traces.finish('run-failed', 'failed', '执行失败')
    traces.start('run-cancelled', 'trace-cancelled', '删除线路')
    traces.record('run-cancelled', { type: 'confirmation', decision: 'rejected' })
    traces.finish('run-cancelled', 'cancelled', '用户取消')

    expect(traces.recent()).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: 'run-success', status: 'completed', endedAt: expect.any(Number) }),
      expect.objectContaining({ runId: 'run-failed', status: 'failed', stopReason: '执行失败' }),
      expect.objectContaining({ runId: 'run-cancelled', status: 'cancelled', stopReason: '用户取消' })
    ]))
  })

  it('默认只保留最近 100 个 Run', () => {
    const traces = new TraceCollector()
    for (let index = 0; index < 101; index += 1) {
      traces.start('run-' + index, 'trace-' + index, 'input-' + index)
      traces.finish('run-' + index, 'completed')
    }

    expect(traces.recent()).toHaveLength(100)
    expect(traces.recent()[0].runId).toBe('run-1')
    expect(traces.recent()[99].runId).toBe('run-100')
  })

  it('每次变更持久化到 localStorage 并能在新实例恢复', () => {
    const storage = createStorage()
    const traces = new TraceCollector(100, storage)

    traces.start('run-7', 'trace-7', '查询话单')
    traces.record('run-7', { type: 'candidates', names: ['cdr'] })
    traces.finish('run-7', 'completed')

    expect(storage.values.has(DEFAULT_TRACE_STORAGE_KEY)).toBe(true)
    expect(new TraceCollector(100, storage).recent()).toEqual(traces.recent())
  })

  it('恢复时裁剪超额记录并返回已持久化的最大 Run 序号', () => {
    const persisted = Array.from({ length: 105 }, (_, index) => ({
      runId: `run-${index + 1}`,
      traceId: `trace-${index + 1}`,
      inputSummary: '[redacted:length=1]',
      startedAt: index,
      status: 'completed',
      endedAt: index + 1,
      events: []
    }))
    const storage = createStorage({
      [DEFAULT_TRACE_STORAGE_KEY]: JSON.stringify(persisted)
    })

    const traces = new TraceCollector(100, storage)

    expect(traces.recent()).toHaveLength(100)
    expect(traces.recent()[0].runId).toBe('run-6')
    expect(traces.latestSequence()).toBe(105)
  })

  it('损坏数据或存储异常时降级为内存模式', () => {
    const corrupted = createStorage({ [DEFAULT_TRACE_STORAGE_KEY]: '{bad-json' })
    const traces = new TraceCollector(100, corrupted)
    const unavailable: TraceStorage = {
      getItem: () => { throw new Error('storage disabled') },
      setItem: () => { throw new Error('quota exceeded') }
    }
    const fallback = new TraceCollector(100, unavailable)

    traces.start('run-1', 'trace-1', '查询')
    fallback.start('run-2', 'trace-2', '查询')
    fallback.finish('run-2', 'completed')

    expect(traces.recent()).toHaveLength(1)
    expect(fallback.recent()[0]).toMatchObject({ runId: 'run-2', status: 'completed' })
  })

  it('不保存任何原始输入内容，只保留长度和 Run 诊断元信息', () => {
    const traces = new TraceCollector()
    const phone = '13800138000'
    const token = 'sk-internal-token-987654'
    const secret = 'LONG_SECRET_VALUE_ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    const businessText = '查询普通业务文字的话单'
    const userInput = `${businessText} phone=${phone} token=${token} secret=${secret}`
    traces.start('run-safe', 'trace-safe', userInput)
    traces.record('run-safe', { type: 'candidates', names: ['cdr'] })
    traces.record('run-safe', {
      type: 'tool',
      functionName: 'cdr_query_v1',
      toolCallId: 'call-safe'
    })
    traces.record('run-safe', {
      type: 'prepared',
      functionName: 'gateway_update_v1',
      summary: { title: '确认更新', rowLabels: ['线路名称'] }
    })
    traces.finish('run-safe', 'completed')

    const recent = traces.recent()
    expect(recent[0]).toMatchObject({
      runId: 'run-safe',
      traceId: 'trace-safe',
      inputSummary: `[redacted:length=${userInput.length}]`,
      status: 'completed',
      events: [
        { type: 'candidates', names: ['cdr'] },
        { type: 'tool', functionName: 'cdr_query_v1', toolCallId: 'call-safe' },
        {
          type: 'prepared',
          functionName: 'gateway_update_v1',
          summary: { title: '确认更新', rowLabels: ['线路名称'] }
        }
      ]
    })
    const serialized = JSON.stringify(recent)
    expect(serialized).not.toContain(phone)
    expect(serialized).not.toContain(token)
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain(businessText)
    expect(serialized).not.toContain(userInput.slice(0, 20))
    expect(serialized).not.toContain('payload')
    expect(serialized).not.toContain('arguments')
    expect(serialized).not.toContain('prompt')
  })

  it('向未开始的 Run 写入事件或结束时返回确定性错误', () => {
    const traces = new TraceCollector()

    expect(() => traces.record('missing', { type: 'thinking' })).toThrow('Trace Run 不存在: missing')
    expect(() => traces.finish('missing', 'failed')).toThrow('Trace Run 不存在: missing')
  })
})
