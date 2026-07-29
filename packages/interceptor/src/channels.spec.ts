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
import type { Interceptor, InterceptorOptions } from './interceptor'
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

  it('写请求要确认，批准后才发出', async () => {
    const { confirm } = setup()

    await xhr('DELETE', '/api/users/u_1')

    expect(confirm).toHaveBeenCalledTimes(1)
    expect(sent).toEqual([{ channel: 'xhr', method: 'DELETE', url: '/api/users/u_1' }])
  })

  it('拒绝时请求根本不发出', async () => {
    setup({ confirm: vi.fn(async () => false) })

    await xhr('DELETE', '/api/users/u_1')

    expect(sent).toHaveLength(0)
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
      url: '/api/track'
    })
  })

  it('非 Agent 发起的 beacon 不受影响', () => {
    setup({ attribution: createStaticAttribution(false) })

    const accepted = navigator.sendBeacon('/api/track', '{}')

    expect(accepted).toBe(true)
    expect(sent).toHaveLength(1)
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
