import { beforeEach, describe, expect, it } from 'vitest'
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
  document.body.innerHTML = `
    <main>
      <h1>数据统计</h1>
      <p>今日共有 1842 条记录。</p>
    </main>
  `
  window.history.replaceState(null, '', '/')
})

describe('runLegacyRuntime', () => {
  it('用真实页面读取工具完成任务，并按实际工具调用统计步骤', async () => {
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
  })
})
