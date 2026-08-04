import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RunDeadlinePhase } from '../contracts/deadline'
import {
  RunDeadline,
  RunDeadlineExceededError
} from './runDeadline'

function createDeadline(
  budgetMs = 100,
  onPhaseStart?: (phase: RunDeadlinePhase) => void
) {
  const controller = new AbortController()
  const timeouts: RunDeadlinePhase[] = []
  const deadline = new RunDeadline({
    budgetMs,
    startedAt: Date.now(),
    now: Date.now,
    controller,
    onTimeout: details => {
      timeouts.push(details.phase)
      return true
    },
    onPhaseStart
  })
  return { controller, deadline, timeouts }
}

describe('RunDeadline', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('operation 忽略 signal 时仍在剩余总预算内超时', async() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const { deadline, timeouts } = createDeadline(100)
    const first = deadline.run('page_context', async() => 'ok')
    await expect(first).resolves.toBe('ok')
    vi.setSystemTime(60)
    const hanging = deadline.run(
      'model_call',
      () => new Promise<never>(() => undefined)
    )
    const rejected = expect(hanging).rejects.toBeInstanceOf(
      RunDeadlineExceededError
    )
    await vi.advanceTimersByTimeAsync(40)
    await rejected
    expect(timeouts).toEqual(['model_call'])
  })

  it('pause 期间不消耗预算', async() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const { deadline } = createDeadline(100)
    vi.setSystemTime(60)
    deadline.pause()
    vi.setSystemTime(1060)
    deadline.resume()
    expect(deadline.remainingMs()).toBe(40)
  })

  it('AbortSignal 先中止时立即退出且不记超时', async() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const { controller, deadline, timeouts } = createDeadline(100)
    const hanging = deadline.run(
      'model_call',
      () => new Promise<never>(() => undefined)
    )
    controller.abort(Object.assign(new Error('stopped'), { name: 'AbortError' }))
    await expect(hanging).rejects.toMatchObject({ name: 'AbortError' })
    expect(timeouts).toEqual([])
  })

  it('operation 尚未开始时 abort 不再调用真实操作', async() => {
    const { controller, deadline } = createDeadline(100)
    const operation = vi.fn(async() => 'ok')

    const running = deadline.run('write_execution', operation)
    controller.abort(Object.assign(new Error('stopped'), { name: 'AbortError' }))

    await expect(running).rejects.toMatchObject({ name: 'AbortError' })
    expect(operation).not.toHaveBeenCalled()
  })

  it('operation 尚未开始时 abort 不提前标记 phase start', async() => {
    const onPhaseStart = vi.fn()
    const { controller, deadline } = createDeadline(100, onPhaseStart)

    const running = deadline.run('write_execution', async() => 'ok')
    controller.abort(Object.assign(new Error('stopped'), { name: 'AbortError' }))

    await expect(running).rejects.toMatchObject({ name: 'AbortError' })
    expect(onPhaseStart).not.toHaveBeenCalled()
  })
})
