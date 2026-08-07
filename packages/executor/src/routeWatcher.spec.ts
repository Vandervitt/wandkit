import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  startRequestTracking,
  stopRequestTracking,
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

  it('stop 不覆盖后来安装在 route watcher 外层的 history patch', () => {
    const originalPush = history.pushState
    const originalReplace = history.replaceState
    watcher = watchRouteChanges({ onRouteChange: vi.fn() })
    const watchedPush = history.pushState
    const watchedReplace = history.replaceState
    const outerPush = function outerPush(
      this: History,
      ...args: Parameters<History['pushState']>
    ) {
      return watchedPush.apply(this, args)
    }
    const outerReplace = function outerReplace(
      this: History,
      ...args: Parameters<History['replaceState']>
    ) {
      return watchedReplace.apply(this, args)
    }
    history.pushState = outerPush
    history.replaceState = outerReplace

    try {
      watcher.stop()
      watcher = undefined

      expect(history.pushState).toBe(outerPush)
      expect(history.replaceState).toBe(outerReplace)
    } finally {
      history.pushState = originalPush
      history.replaceState = originalReplace
    }
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

  it('请求在途时不判稳定——静默不等于稳定', async () => {
    // 真实应用实测的 bug：点击查询后表格先清空（一次 DOM 变更），随后在等待 API
    // 响应的几百毫秒里 DOM 完全静止，静默期被满足，于是抓到一个空表格。
    // 实测 captureStable 仅 329ms 就返回 0 行，再等 1500ms 是 8 行。
    let resolveRequest: (value: Response) => void = () => undefined
    const inflight = new Promise<Response>(resolve => { resolveRequest = resolve })
    const originalFetch = window.fetch
    // 先卸掉可能残留的 tracker，再换上受控 fetch，最后由 waitForDomStable 安装
    // tracker——顺序反了会把 tracker 装到旧 fetch 上。
    stopRequestTracking()
    window.fetch = (() => inflight) as typeof fetch

    let settled = false
    const waiting = waitForDomStable({ quietMs: 50, timeoutMs: 3000 })
      .then(stable => { settled = true; return stable })

    // tracker 已安装，此时发起的请求才会被计数
    void window.fetch('/api/list')
    document.body.appendChild(document.createElement('div'))

    // 静默期早已过去，但请求还在途，不得判稳定
    await new Promise(r => setTimeout(r, 250))
    expect(settled).toBe(false)

    resolveRequest(new Response('[]'))
    await expect(waiting).resolves.toBe(true)

    stopRequestTracking()
    window.fetch = originalFetch
  })

  it('显式启动后能跟踪 waitForDomStable 调用前发起的请求', async () => {
    let resolveRequest: (value: Response) => void = () => undefined
    const inflight = new Promise<Response>(resolve => { resolveRequest = resolve })
    const originalFetch = window.fetch
    stopRequestTracking()
    window.fetch = (() => inflight) as typeof fetch
    const releaseTracking = startRequestTracking()

    void window.fetch('/api/started-before-wait')
    let settled = false
    const waiting = waitForDomStable({ quietMs: 30, timeoutMs: 1000 })
      .then(stable => { settled = true; return stable })

    await new Promise(resolve => setTimeout(resolve, 100))
    expect(settled).toBe(false)

    resolveRequest(new Response('[]'))
    await expect(waiting).resolves.toBe(true)

    releaseTracking()
    window.fetch = originalFetch
  })

  it('多个显式使用者各自释放租约，最后一个释放时才卸载 tracker', () => {
    const originalFetch = window.fetch
    const releaseHost = startRequestTracking()
    const trackedFetch = window.fetch
    const releaseBrowser = startRequestTracking()

    expect(typeof releaseHost).toBe('function')
    expect(typeof releaseBrowser).toBe('function')
    expect(window.fetch).toBe(trackedFetch)

    stopRequestTracking()
    expect(window.fetch).toBe(trackedFetch)

    releaseBrowser()
    expect(window.fetch).toBe(trackedFetch)

    releaseHost()
    expect(window.fetch).toBe(originalFetch)
  })

  it('释放租约时不覆盖后来安装在 tracker 外层的 patch', () => {
    const originalFetch = window.fetch
    const originalSend = XMLHttpRequest.prototype.send
    const releaseTracking = startRequestTracking()
    const trackedFetch = window.fetch
    const trackedSend = XMLHttpRequest.prototype.send
    const outerFetch = function outerFetch(
      this: unknown,
      ...args: Parameters<typeof fetch>
    ) {
      return trackedFetch.apply(this, args)
    } as typeof fetch
    const outerSend = function outerSend(
      this: XMLHttpRequest,
      ...args: Parameters<XMLHttpRequest['send']>
    ) {
      return trackedSend.apply(this, args)
    }
    window.fetch = outerFetch
    XMLHttpRequest.prototype.send = outerSend

    try {
      releaseTracking()

      expect(window.fetch).toBe(outerFetch)
      expect(XMLHttpRequest.prototype.send).toBe(outerSend)
    } finally {
      window.fetch = originalFetch
      XMLHttpRequest.prototype.send = originalSend
    }
  })

  it('关闭 trackRequests 后退回纯 DOM 静默判据', async () => {
    const originalFetch = window.fetch
    stopRequestTracking()
    window.fetch = (() => new Promise<Response>(() => undefined)) as typeof fetch
    void window.fetch('/api/never')

    // 不跟踪请求时，DOM 静默即判稳定
    await expect(
      waitForDomStable({ quietMs: 30, timeoutMs: 1000, trackRequests: false })
    ).resolves.toBe(true)

    stopRequestTracking()
    window.fetch = originalFetch
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
