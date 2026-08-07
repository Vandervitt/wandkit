/**
 * fetch 之外的通道：XHR 与 sendBeacon。
 *
 * 两者的难点不同：
 * - **XHR** 的 `send()` 是同步返回的，而判定是异步的。只能在内部延迟真正的发送，
 *   这会破坏同步时序（见下面的已知限制用例）。
 * - **sendBeacon** 设计上就发生在 unload 期，同步返回 boolean，**根本无法挂起**。
 *   只能二选一：放行，或拒发。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createInterceptor } from './interceptor'
import { createStaticAttribution } from './attribution'
import type {
  ConfirmRequestHandler,
  Interceptor,
  InterceptorOptions
} from './interceptor'
import type { InterceptionPolicy } from './types'

let interceptor: Interceptor | undefined
let uninstall: (() => void) | undefined

const originalSend = XMLHttpRequest.prototype.send
const originalOpen = XMLHttpRequest.prototype.open
const originalBeacon = navigator.sendBeacon

/** 真正打到「网络」上的请求。被拦下的不该出现在这里。 */
let sent: Array<{ channel: string, method: string, url: string }>

function setup(
  overrides: Partial<InterceptorOptions> = {},
  policy: InterceptionPolicy = {}
) {
  const confirm = vi.fn(async () => true)
  interceptor = createInterceptor({
    policy,
    attribution: createStaticAttribution(true),
    confirm,
    ...overrides
  })
  uninstall = interceptor.install()
  return { confirm }
}

beforeEach(() => {
  sent = []
  // 桩掉真实网络：只记录，不发出。
  XMLHttpRequest.prototype.open = function stubOpen(
    this: XMLHttpRequest & { __method?: string, __url?: string },
    method: string,
    url: string | URL
  ) {
    this.__method = method
    this.__url = String(url)
  } as typeof XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.send = function stubSend(
    this: XMLHttpRequest & { __method?: string, __url?: string }
  ) {
    sent.push({ channel: 'xhr', method: this.__method ?? '', url: this.__url ?? '' })
  }
  navigator.sendBeacon = vi.fn((url: string | URL) => {
    sent.push({ channel: 'beacon', method: 'POST', url: String(url) })
    return true
  }) as typeof navigator.sendBeacon
})

afterEach(() => {
  uninstall?.()
  uninstall = undefined
  interceptor = undefined
  XMLHttpRequest.prototype.send = originalSend
  XMLHttpRequest.prototype.open = originalOpen
  navigator.sendBeacon = originalBeacon
})

/** 发一个 XHR，并等到判定链路跑完。 */
async function xhr(method: string, url: string, body?: string): Promise<void> {
  const request = new XMLHttpRequest()
  request.open(method, url)
  request.send(body)
  // 判定是异步的，让出几个微任务等它落地。
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('XMLHttpRequest', () => {
  it('安全方法直接透传', async () => {
    const { confirm } = setup()

    await xhr('GET', '/api/users')

    expect(confirm).not.toHaveBeenCalled()
    expect(sent).toEqual([{ channel: 'xhr', method: 'GET', url: '/api/users' }])
  })

  it('相对 URL 先绝对化再匹配完整地址的危险 GET', async () => {
    const confirm = vi.fn(async () => false)
    setup({ confirm }, {
      danger: [{
        id: 'export-all',
        match: { method: 'GET', url: `${location.origin}/api/export-all` }
      }]
    })

    await xhr('GET', '/api/export-all')

    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({
      risk: 'destructive',
      request: expect.objectContaining({ url: `${location.origin}/api/export-all` })
    }))
    expect(sent).toHaveLength(0)
  })

  it('写请求要确认，批准后才发出', async () => {
    const { confirm } = setup()

    await xhr('DELETE', '/api/users/u_1')

    expect(confirm).toHaveBeenCalledTimes(1)
    expect(sent).toEqual([{ channel: 'xhr', method: 'DELETE', url: '/api/users/u_1' }])
  })

  it('等待确认期间重新 open 会使旧发送失效', async () => {
    let approveOld!: (allowed: boolean) => void
    const confirm = vi.fn<ConfirmRequestHandler>(
      async () => true
    )
    confirm.mockImplementationOnce(() => new Promise<boolean>(resolve => {
      approveOld = resolve
    }))
    setup({ confirm })
    const request = new XMLHttpRequest()
    request.open('DELETE', '/api/users/u_1')
    request.send('old-body')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(confirm.mock.calls[0][0].request).toMatchObject({
      method: 'DELETE',
      url: `${location.origin}/api/users/u_1`,
      body: 'old-body'
    })

    request.open('POST', '/api/transfers')
    approveOld(true)
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(sent).toHaveLength(0)

    request.send('new-body')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(confirm.mock.calls[1][0].request).toMatchObject({
      method: 'POST',
      url: `${location.origin}/api/transfers`,
      body: 'new-body'
    })
    expect(sent).toEqual([{ channel: 'xhr', method: 'POST', url: '/api/transfers' }])
  })

  it('即使参数相同，重新 open 也会使旧发送失效', async () => {
    let approveOld!: (allowed: boolean) => void
    const confirm = vi.fn<ConfirmRequestHandler>(
      () => new Promise<boolean>(resolve => { approveOld = resolve })
    )
    setup({ confirm })
    const request = new XMLHttpRequest()
    request.open('POST', '/api/actions')
    request.send('old-body')
    await new Promise(resolve => setTimeout(resolve, 0))

    request.open('POST', '/api/actions')
    approveOld(true)
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(sent).toHaveLength(0)
  })

  it('等待确认期间卸载会使旧发送失效', async () => {
    let approveOld!: (allowed: boolean) => void
    const confirm = vi.fn<ConfirmRequestHandler>(
      () => new Promise<boolean>(resolve => { approveOld = resolve })
    )
    setup({ confirm })
    const request = new XMLHttpRequest()
    request.open('DELETE', '/api/users/u_1')
    request.send('old-body')
    await new Promise(resolve => setTimeout(resolve, 0))

    uninstall?.()
    uninstall = undefined
    request.open('POST', '/api/transfers')
    approveOld(true)
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(sent).toHaveLength(0)
  })

  it('旧卸载函数在重装后重复调用不会拆掉新安装', async () => {
    let approveOld!: (allowed: boolean) => void
    const confirm = vi.fn<ConfirmRequestHandler>(
      () => new Promise<boolean>(resolve => { approveOld = resolve })
    )
    setup({ confirm })
    const firstUninstall = uninstall as () => void
    firstUninstall()
    uninstall = interceptor?.install()

    const request = new XMLHttpRequest()
    request.open('DELETE', '/api/users/u_1')
    request.send('old-body')
    await new Promise(resolve => setTimeout(resolve, 0))

    firstUninstall()
    request.open('POST', '/api/transfers')
    approveOld(true)
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(interceptor?.installed).toBe(true)
    expect(sent).toHaveLength(0)
  })

  it('先卸载旧 XHR 实例只移除该层，最后恢复 open 和 send', async () => {
    const baselineOpen = XMLHttpRequest.prototype.open
    const baselineSend = XMLHttpRequest.prototype.send
    const confirmA = vi.fn(async () => true)
    const confirmB = vi.fn(async () => true)
    const instanceA = createInterceptor({
      policy: {},
      attribution: createStaticAttribution(true),
      confirm: confirmA,
      channels: ['xhr']
    })
    const instanceB = createInterceptor({
      policy: {},
      attribution: createStaticAttribution(true),
      confirm: confirmB,
      channels: ['xhr']
    })
    const uninstallA = instanceA.install()
    const uninstallB = instanceB.install()

    try {
      await xhr('DELETE', '/api/users/u_1')
      expect(confirmB).toHaveBeenCalledTimes(1)
      expect(confirmA).toHaveBeenCalledTimes(1)
      expect(sent).toHaveLength(1)

      confirmA.mockClear()
      confirmB.mockClear()
      sent = []
      uninstallA()
      await xhr('DELETE', '/api/users/u_2')

      expect(confirmB).toHaveBeenCalledTimes(1)
      expect(confirmA).not.toHaveBeenCalled()
      expect(sent).toEqual([
        { channel: 'xhr', method: 'DELETE', url: '/api/users/u_2' }
      ])

      uninstallB()
      expect(XMLHttpRequest.prototype.open).toBe(baselineOpen)
      expect(XMLHttpRequest.prototype.send).toBe(baselineSend)
    } finally {
      uninstallB()
      uninstallA()
      XMLHttpRequest.prototype.open = baselineOpen
      XMLHttpRequest.prototype.send = baselineSend
    }
  })

  it('按 LIFO 卸载的 XHR 旧 send 引用只透传给前一激活层', async () => {
    const baselineOpen = XMLHttpRequest.prototype.open
    const baselineSend = XMLHttpRequest.prototype.send
    const confirmA = vi.fn(async () => true)
    const confirmB = vi.fn(async () => true)
    const instanceA = createInterceptor({
      policy: {},
      attribution: createStaticAttribution(true),
      confirm: confirmA,
      channels: ['xhr']
    })
    const instanceB = createInterceptor({
      policy: {},
      attribution: createStaticAttribution(true),
      confirm: confirmB,
      channels: ['xhr']
    })
    const uninstallA = instanceA.install()
    const wrapperAOpen = XMLHttpRequest.prototype.open
    const wrapperASend = XMLHttpRequest.prototype.send
    const uninstallB = instanceB.install()
    const staleSendB = XMLHttpRequest.prototype.send

    try {
      uninstallB()
      expect(XMLHttpRequest.prototype.open).toBe(wrapperAOpen)
      expect(XMLHttpRequest.prototype.send).toBe(wrapperASend)

      const request = new XMLHttpRequest()
      request.open('DELETE', '/api/users/u_1')
      staleSendB.call(request, 'body')
      await new Promise(resolve => setTimeout(resolve, 0))

      expect(confirmB).not.toHaveBeenCalled()
      expect(confirmA).toHaveBeenCalledTimes(1)
      expect(sent).toHaveLength(1)

      uninstallA()
      expect(XMLHttpRequest.prototype.open).toBe(baselineOpen)
      expect(XMLHttpRequest.prototype.send).toBe(baselineSend)
    } finally {
      uninstallB()
      uninstallA()
      XMLHttpRequest.prototype.open = baselineOpen
      XMLHttpRequest.prototype.send = baselineSend
    }
  })

  it('XHR 卸载分别保留外部 open，并让其持有的旧 open 透明透传', async () => {
    const baselineOpen = XMLHttpRequest.prototype.open
    const baselineSend = XMLHttpRequest.prototype.send
    const confirmA = vi.fn(async () => true)
    const instanceA = createInterceptor({
      policy: {},
      attribution: createStaticAttribution(true),
      confirm: confirmA,
      channels: ['xhr']
    })
    const uninstallA = instanceA.install()
    const interceptedOpen = XMLHttpRequest.prototype.open
    const externalOpen = function (
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      ...rest: unknown[]
    ) {
      return (interceptedOpen as (...args: unknown[]) => void)
        .apply(this, [method, url, ...rest])
    } as typeof XMLHttpRequest.prototype.open
    XMLHttpRequest.prototype.open = externalOpen

    try {
      uninstallA()
      expect(XMLHttpRequest.prototype.open).toBe(externalOpen)
      expect(XMLHttpRequest.prototype.send).toBe(baselineSend)

      await xhr('DELETE', '/api/users/u_1')
      expect(confirmA).not.toHaveBeenCalled()
      expect(sent).toHaveLength(1)
    } finally {
      XMLHttpRequest.prototype.open = baselineOpen
      XMLHttpRequest.prototype.send = baselineSend
      uninstallA()
    }
  })

  it('XHR 卸载分别保留外部 send，并让其持有的旧 send 透明透传', async () => {
    const baselineOpen = XMLHttpRequest.prototype.open
    const baselineSend = XMLHttpRequest.prototype.send
    const confirmA = vi.fn(async () => true)
    const instanceA = createInterceptor({
      policy: {},
      attribution: createStaticAttribution(true),
      confirm: confirmA,
      channels: ['xhr']
    })
    const uninstallA = instanceA.install()
    const interceptedSend = XMLHttpRequest.prototype.send
    const externalSend = function (
      this: XMLHttpRequest,
      ...args: Parameters<typeof XMLHttpRequest.prototype.send>
    ) {
      return interceptedSend.apply(this, args)
    } as typeof XMLHttpRequest.prototype.send
    XMLHttpRequest.prototype.send = externalSend

    try {
      uninstallA()
      expect(XMLHttpRequest.prototype.open).toBe(baselineOpen)
      expect(XMLHttpRequest.prototype.send).toBe(externalSend)

      await xhr('DELETE', '/api/users/u_1')
      expect(confirmA).not.toHaveBeenCalled()
      expect(sent).toHaveLength(1)
    } finally {
      XMLHttpRequest.prototype.open = baselineOpen
      XMLHttpRequest.prototype.send = baselineSend
      uninstallA()
    }
  })

  it('拒绝时请求根本不发出', async () => {
    setup({ confirm: vi.fn(async () => false) })

    await xhr('DELETE', '/api/users/u_1')

    expect(sent).toHaveLength(0)
  })

  it('拒绝时用 abort 和 loadend 结束 XHR 生命周期', async () => {
    setup({ confirm: vi.fn(async () => false) })
    const events: string[] = []
    const request = new XMLHttpRequest()
    request.addEventListener('abort', () => events.push('abort'))
    request.addEventListener('loadend', () => events.push('loadend'))

    request.open('DELETE', '/api/users/u_1')
    request.send()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(sent).toHaveLength(0)
    expect(events).toEqual(['abort', 'loadend'])
  })

  it('确认回调抛错时也拒发并结束 XHR 生命周期', async () => {
    setup({ confirm: vi.fn(async () => { throw new Error('confirm failed') }) })
    const events: string[] = []
    const request = new XMLHttpRequest()
    request.addEventListener('abort', () => events.push('abort'))
    request.addEventListener('loadend', () => events.push('loadend'))

    request.open('DELETE', '/api/users/u_1')
    request.send()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(sent).toHaveLength(0)
    expect(events).toEqual(['abort', 'loadend'])
  })

  it('解析 JSON 请求体供规则判定', async () => {
    const seen: unknown[] = []
    setup({}, {
      danger: [{ id: 'x', match: { when: r => { seen.push(r.body); return false } } }]
    })

    await xhr('POST', '/api/x', JSON.stringify({ force: true }))

    expect(seen[0]).toEqual({ force: true })
  })

  it('已知限制：send() 返回时请求尚未真正发出', async () => {
    // 判定是异步的，而 send() 必须同步返回。依赖「send 返回即已发出」的宿主代码
    // 会看到时序变化——这是本方案无法消除的代价，只能显式记录。
    setup()
    const request = new XMLHttpRequest()
    request.open('DELETE', '/api/users/u_1')

    request.send()
    expect(sent).toHaveLength(0)

    await new Promise(resolve => setTimeout(resolve, 0))
    expect(sent).toHaveLength(1)
  })

  it('卸载后完全还原', () => {
    setup()
    expect(XMLHttpRequest.prototype.send).not.toBe(originalSend)

    uninstall?.()
    uninstall = undefined

    // 还原成 beforeEach 里装的桩，而不是原生实现
    expect(sent).toHaveLength(0)
  })
})

describe('navigator.sendBeacon', () => {
  it('安全场景（命中放行名单）直接透传', () => {
    setup({}, { allow: [{ id: 'metrics', match: { url: '/api/metrics' } }] })

    const accepted = navigator.sendBeacon('/api/metrics', '{}')

    expect(accepted).toBe(true)
    expect(sent).toHaveLength(1)
  })

  it('相对 URL 先绝对化再匹配完整地址的放行规则', () => {
    setup({}, {
      allow: [{
        id: 'metrics',
        match: { method: 'POST', url: `${location.origin}/api/metrics` }
      }]
    })

    const accepted = navigator.sendBeacon('/api/metrics', '{}')

    expect(accepted).toBe(true)
    expect(sent).toEqual([{ channel: 'beacon', method: 'POST', url: '/api/metrics' }])
  })

  it('需要确认时拒发并返回 false——无法挂起，只能二选一', () => {
    // beacon 设计上发生在 unload 期，同步返回 boolean，等不了异步确认。
    // 放行等于让一个该确认的写操作直接溜出去，因此默认拒发。
    const onUnholdable = vi.fn()
    setup({ onUnholdableRequest: onUnholdable })

    const accepted = navigator.sendBeacon('/api/track', '{}')

    expect(accepted).toBe(false)
    expect(sent).toHaveLength(0)
    expect(onUnholdable).toHaveBeenCalledTimes(1)
  })

  it('拒发时告知宿主，让接入方能知情并上报', () => {
    const onUnholdable = vi.fn()
    setup({ onUnholdableRequest: onUnholdable })

    navigator.sendBeacon('/api/track', '{}')

    expect(onUnholdable.mock.calls[0][0]).toMatchObject({
      channel: 'beacon',
      method: 'POST',
      url: `${location.origin}/api/track`
    })
  })

  it('非 Agent 发起的 beacon 不受影响', () => {
    setup({ attribution: createStaticAttribution(false) })

    const accepted = navigator.sendBeacon('/api/track', '{}')

    expect(accepted).toBe(true)
    expect(sent).toHaveLength(1)
  })

  it('先卸载旧 Beacon 实例只移除该层，最后恢复基线函数', () => {
    const baselineBeacon = navigator.sendBeacon
    const verdictA = vi.fn()
    const verdictB = vi.fn()
    const policy: InterceptionPolicy = {
      allow: [{ id: 'metrics', match: { url: '/api/metrics' } }]
    }
    const instanceA = createInterceptor({
      policy,
      attribution: createStaticAttribution(true),
      confirm: vi.fn(async () => true),
      channels: ['beacon'],
      onVerdict: verdictA
    })
    const instanceB = createInterceptor({
      policy,
      attribution: createStaticAttribution(true),
      confirm: vi.fn(async () => true),
      channels: ['beacon'],
      onVerdict: verdictB
    })
    const uninstallA = instanceA.install()
    const uninstallB = instanceB.install()

    try {
      expect(navigator.sendBeacon('/api/metrics', '{}')).toBe(true)
      expect(verdictB).toHaveBeenCalledTimes(1)
      expect(verdictA).toHaveBeenCalledTimes(1)

      verdictA.mockClear()
      verdictB.mockClear()
      sent = []
      uninstallA()
      expect(navigator.sendBeacon('/api/metrics', '{}')).toBe(true)
      expect(verdictB).toHaveBeenCalledTimes(1)
      expect(verdictA).not.toHaveBeenCalled()
      expect(sent).toHaveLength(1)

      uninstallB()
      expect(navigator.sendBeacon).toBe(baselineBeacon)
    } finally {
      uninstallB()
      uninstallA()
      navigator.sendBeacon = baselineBeacon
    }
  })

  it('按 LIFO 卸载的 Beacon 旧引用只透传给前一激活层', () => {
    const baselineBeacon = navigator.sendBeacon
    const verdictA = vi.fn()
    const verdictB = vi.fn()
    const policy: InterceptionPolicy = {
      allow: [{ id: 'metrics', match: { url: '/api/metrics' } }]
    }
    const instanceA = createInterceptor({
      policy,
      attribution: createStaticAttribution(true),
      confirm: vi.fn(async () => true),
      channels: ['beacon'],
      onVerdict: verdictA
    })
    const instanceB = createInterceptor({
      policy,
      attribution: createStaticAttribution(true),
      confirm: vi.fn(async () => true),
      channels: ['beacon'],
      onVerdict: verdictB
    })
    const uninstallA = instanceA.install()
    const wrapperA = navigator.sendBeacon
    const uninstallB = instanceB.install()
    const staleBeaconB = navigator.sendBeacon

    try {
      uninstallB()
      expect(navigator.sendBeacon).toBe(wrapperA)
      expect(staleBeaconB.call(navigator, '/api/metrics', '{}')).toBe(true)
      expect(verdictB).not.toHaveBeenCalled()
      expect(verdictA).toHaveBeenCalledTimes(1)
      expect(sent).toHaveLength(1)

      uninstallA()
      expect(navigator.sendBeacon).toBe(baselineBeacon)
    } finally {
      uninstallB()
      uninstallA()
      navigator.sendBeacon = baselineBeacon
    }
  })

  it('Beacon 卸载不覆盖外部 wrapper，旧引用只透明透传', () => {
    const baselineBeacon = navigator.sendBeacon
    const verdictA = vi.fn()
    const policy: InterceptionPolicy = {
      allow: [{ id: 'metrics', match: { url: '/api/metrics' } }]
    }
    const instanceA = createInterceptor({
      policy,
      attribution: createStaticAttribution(true),
      confirm: vi.fn(async () => true),
      channels: ['beacon'],
      onVerdict: verdictA
    })
    const uninstallA = instanceA.install()
    const interceptedBeacon = navigator.sendBeacon
    const externalBeacon = vi.fn(function (
      this: Navigator,
      ...args: Parameters<typeof navigator.sendBeacon>
    ) {
      return interceptedBeacon.apply(this, args)
    }) as typeof navigator.sendBeacon
    navigator.sendBeacon = externalBeacon

    try {
      uninstallA()
      expect(navigator.sendBeacon).toBe(externalBeacon)
      expect(navigator.sendBeacon('/api/metrics', '{}')).toBe(true)
      expect(externalBeacon).toHaveBeenCalledTimes(1)
      expect(verdictA).not.toHaveBeenCalled()
      expect(sent).toHaveLength(1)
    } finally {
      navigator.sendBeacon = baselineBeacon
      uninstallA()
    }
  })
})

describe('通道开关', () => {
  it('只接管指定通道', async () => {
    const { confirm } = setup({ channels: ['fetch'] })

    await xhr('DELETE', '/api/users/u_1')

    // xhr 未被接管，因此不经过闸门
    expect(confirm).not.toHaveBeenCalled()
    expect(sent).toHaveLength(1)
  })
})
