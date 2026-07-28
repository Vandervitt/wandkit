import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  waitForDomStable,
  watchRouteChanges,
  type RouteWatcher
} from './routeWatcher'

let watcher: RouteWatcher | undefined

afterEach(() => {
  watcher?.stop()
  watcher = undefined
  document.body.replaceChildren()
})

describe('watchRouteChanges', () => {
  it('侦测 pushState —— SPA 前进最常走的路径，浏览器不派发任何事件', async () => {
    const onRouteChange = vi.fn()
    watcher = watchRouteChanges({ onRouteChange })

    history.pushState({}, '', '/users')
    await Promise.resolve()

    expect(onRouteChange).toHaveBeenCalledTimes(1)
    expect(onRouteChange.mock.calls[0][0]).toContain('/users')
  })

  it('侦测 replaceState', async () => {
    const onRouteChange = vi.fn()
    watcher = watchRouteChanges({ onRouteChange })

    history.replaceState({}, '', '/settings')
    await Promise.resolve()

    expect(onRouteChange).toHaveBeenCalledTimes(1)
  })

  it('侦测 popstate（前进 / 后退）', () => {
    const onRouteChange = vi.fn()
    history.pushState({}, '', '/a')
    watcher = watchRouteChanges({ onRouteChange })

    history.replaceState({}, '', '/b')
    window.dispatchEvent(new PopStateEvent('popstate'))

    expect(onRouteChange).toHaveBeenCalled()
  })

  it('URL 未变时不触发——一次跳转常同时触发 pushState 与 popstate', async () => {
    const onRouteChange = vi.fn()
    history.pushState({}, '', '/same')
    watcher = watchRouteChanges({ onRouteChange })

    history.pushState({}, '', '/same')
    window.dispatchEvent(new PopStateEvent('popstate'))
    await Promise.resolve()

    expect(onRouteChange).not.toHaveBeenCalled()
  })

  it('stop 后还原 history 方法，不再触发', async () => {
    const onRouteChange = vi.fn()
    const originalPush = history.pushState
    watcher = watchRouteChanges({ onRouteChange })
    expect(history.pushState).not.toBe(originalPush)

    watcher.stop()
    watcher = undefined

    expect(history.pushState).toBe(originalPush)
    history.pushState({}, '', '/after-stop')
    await Promise.resolve()
    expect(onRouteChange).not.toHaveBeenCalled()
  })

  it('重复 stop 是安全的', () => {
    watcher = watchRouteChanges({ onRouteChange: vi.fn() })
    watcher.stop()

    expect(() => watcher?.stop()).not.toThrow()
  })
})

describe('waitForDomStable', () => {
  it('DOM 安静时立刻判定稳定', async () => {
    await expect(waitForDomStable({ quietMs: 20, timeoutMs: 500 })).resolves.toBe(true)
  })

  it('持续变更会推迟判定，停下后才稳定', async () => {
    const start = Date.now()
    const timer = setInterval(() => {
      document.body.appendChild(document.createElement('div'))
    }, 10)
    setTimeout(() => clearInterval(timer), 120)

    const stable = await waitForDomStable({ quietMs: 50, timeoutMs: 2000 })

    expect(stable).toBe(true)
    // 变更持续了 ~120ms，加上 50ms 静默期，不可能在 100ms 内返回
    expect(Date.now() - start).toBeGreaterThanOrEqual(100)
  })

  it('DOM 永不静止时超时返回 false，而不是抛错或卡死', async () => {
    // 轮询、动画、自动刷新的页面 DOM 可能永远静不下来。拿到不完整快照，
    // 远好过让整个 Run 卡在这里。
    const timer = setInterval(() => {
      document.body.appendChild(document.createElement('span'))
    }, 5)

    const stable = await waitForDomStable({ quietMs: 100, timeoutMs: 150 })
    clearInterval(timer)

    expect(stable).toBe(false)
  })
})
