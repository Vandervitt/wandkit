import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  LlmAssistantMessage,
  LlmClient
} from '../../../packages/core/src/index'
import {
  DEFAULT_TRACE_STORAGE_KEY
} from '../../../packages/core/src/index'
import { stopRequestTracking } from '../../../packages/executor/src/index'
import type { LegacyRuntimeResult } from './legacyRuntime'
import { runLegacyRuntime } from './legacyRuntime'
import {
  ScriptedLlm,
  finalAnswer,
  toolCall
} from './scriptedLlm'

if (false) {
  const result = null as unknown as LegacyRuntimeResult

  // @ts-expect-error Runner 结果终态只读
  result.status = 'failed'
  // @ts-expect-error Runner 回答只读
  result.answer = 'changed'
  // @ts-expect-error Runner 步骤数只读
  result.steps = 99
  // @ts-expect-error Runner 停止原因只读
  result.stopReason = 'changed'
}

beforeEach(() => {
  stopRequestTracking()
  window.localStorage.clear()
  document.body.innerHTML = `
    <main>
      <h1>数据统计</h1>
      <p>今日共有 1842 条记录。</p>
    </main>
  `
  window.history.replaceState(null, '', '/')
})

afterEach(() => {
  stopRequestTracking()
  window.localStorage.clear()
})

function deferredLlm(): {
  readonly llm: LlmClient
  resolve(reply: LlmAssistantMessage): void
} {
  let resolveReply: (reply: LlmAssistantMessage) => void = () => undefined
  const pending = new Promise<LlmAssistantMessage>(resolve => {
    resolveReply = resolve
  })
  return {
    llm: { chat: () => pending },
    resolve: resolveReply
  }
}

describe('runLegacyRuntime', () => {
  it('用真实页面读取工具完成任务，并按模型发出的页面动作尝试数统计 steps', async () => {
    const result = await runLegacyRuntime({
      task: '读取统计数字',
      replies: [
        toolCall('page_read_v1', {}),
        finalAnswer('共有 1842 条')
      ]
    })

    expect(result.status).toBe('completed')
    expect(result.answer).toContain('1842')
    expect(result.steps).toBe(1)
    expect(result.stopReason).toBeUndefined()
  })

  it('非法 Schema 参数纠正后，steps 同时计入失败尝试与合法调用', async () => {
    const result = await runLegacyRuntime({
      task: '读取统计数字',
      replies: [
        toolCall('page_read_v1', { unexpected: true }),
        toolCall('page_read_v1', {}),
        finalAnswer('共有 1842 条')
      ]
    })

    expect(result.status).toBe('completed')
    expect(result.answer).toContain('1842')
    expect(result.steps).toBe(2)
  })

  it('模型发出的未知页面工具也计入 steps', async () => {
    const result = await runLegacyRuntime({
      task: '尝试未知动作',
      replies: [
        toolCall('page_missing_v1', {}),
        finalAnswer('没有执行页面操作')
      ]
    })

    expect(result.status).toBe('completed')
    expect(result.steps).toBe(1)
  })

  it('模型直接回答时步骤数为零', async () => {
    const result = await runLegacyRuntime({
      task: '打个招呼',
      replies: [finalAnswer('你好')]
    })

    expect(result).toEqual({
      status: 'completed',
      answer: '你好',
      steps: 0
    })
  })

  it('脚本耗尽时保留 Runtime 的失败终态与停止原因', async () => {
    const result = await runLegacyRuntime({
      task: '读取统计数字',
      replies: []
    })

    expect(result.status).toBe('failed')
    expect(result.answer).toBe('')
    expect(result.steps).toBe(0)
    expect(result.stopReason).toContain('Scripted LLM replies exhausted')
  })

  it('支持注入 ScriptedLlm，并保存与后续轮次隔离的请求快照', async () => {
    const llm = new ScriptedLlm([
      toolCall('page_read_v1', {}),
      finalAnswer('页面显示 1842 条')
    ])

    const result = await runLegacyRuntime({ task: '读取页面', llm })

    expect(result.status).toBe('completed')
    expect(llm.requests).toHaveLength(2)
    expect(llm.requests[0].messages).toContainEqual({
      role: 'user',
      content: '读取页面'
    })
    expect(llm.requests[1].messages).toContainEqual(expect.objectContaining({
      role: 'tool',
      content: expect.stringContaining('1842')
    }))
  })

  it('使用隔离 trace，不读取或覆盖真实 localStorage', async () => {
    const sentinel = 'do-not-touch'
    window.localStorage.setItem(DEFAULT_TRACE_STORAGE_KEY, sentinel)

    await runLegacyRuntime({
      task: '直接回答',
      replies: [finalAnswer('完成')]
    })

    expect(window.localStorage.getItem(DEFAULT_TRACE_STORAGE_KEY)).toBe(sentinel)
  })

  it('真实 DOM 动作结束后恢复请求追踪器包装', async () => {
    document.body.innerHTML = '<button>确认</button>'
    let clicked = false
    document.querySelector('button')?.addEventListener('click', () => {
      clicked = true
    })
    const originalSend = XMLHttpRequest.prototype.send
    const originalFetch = window.fetch

    const result = await runLegacyRuntime({
      task: '点击确认',
      replies: [
        toolCall('page_read_v1', {}),
        toolCall('page_click_v1', { index: 0 }),
        finalAnswer('已点击确认')
      ]
    })

    expect(result.status).toBe('completed')
    expect(clicked).toBe(true)
    expect(XMLHttpRequest.prototype.send).toBe(originalSend)
    if (typeof originalFetch === 'function') {
      expect(window.fetch).toBe(originalFetch)
    }
  })

  it('同一页面拒绝并发 Runner，并在首个结束后释放 guard', async () => {
    const deferred = deferredLlm()
    const first = runLegacyRuntime({ task: '等待模型', llm: deferred.llm })
    await Promise.resolve()

    let concurrentError: unknown
    try {
      await runLegacyRuntime({
        task: '并发调用',
        replies: [finalAnswer('不应执行')]
      })
    } catch (error) {
      concurrentError = error
    } finally {
      deferred.resolve(finalAnswer('首个调用完成'))
      await first
    }

    const next = await runLegacyRuntime({
      task: '结束后重试',
      replies: [finalAnswer('可以再次运行')]
    })

    expect(concurrentError).toBeInstanceOf(Error)
    expect((concurrentError as Error).message).toContain('同一页面不能并发运行')
    expect(next.status).toBe('completed')
    expect(next.answer).toBe('可以再次运行')
  })

  it('明确拒绝同时提供 llm 与 replies', async () => {
    const llm = new ScriptedLlm([finalAnswer('不会执行')])

    await expect(runLegacyRuntime({
      task: '冲突配置',
      llm,
      replies: [finalAnswer('不会执行')]
    })).rejects.toThrow('llm 与 replies 必须且只能提供一个')
  })

  it('明确拒绝既不提供 llm 也不提供 replies', async () => {
    await expect(runLegacyRuntime({
      task: '缺少模型'
    })).rejects.toThrow('llm 与 replies 必须且只能提供一个')

    await expect(runLegacyRuntime({
      task: '构造失败后仍可运行',
      replies: [finalAnswer('已恢复')]
    })).resolves.toMatchObject({
      status: 'completed',
      answer: '已恢复'
    })
  })
})
