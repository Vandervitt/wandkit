import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createInterceptor, RequestDeniedError } from './interceptor'
import { createStaticAttribution } from './attribution'
import type { ConfirmRequestHandler, Interceptor, InterceptorOptions } from './interceptor'
import type { InterceptionPolicy } from './types'

const originalFetch = window.fetch
let interceptor: Interceptor | undefined
let uninstall: (() => void) | undefined

/** 记录实际打到「网络」上的请求——被拦下的不该出现在这里。 */
let sent: Array<{ method: string, url: string }>

function setup(
  overrides: Partial<InterceptorOptions> = {},
  policy: InterceptionPolicy = {}
) {
  const confirm = vi.fn<ConfirmRequestHandler>(
    async () => true
  )
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
  window.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input)
    sent.push({ method: init?.method ?? 'GET', url })
    return new Response('{}', { status: 200 })
  }) as typeof fetch
})

afterEach(() => {
  uninstall?.()
  uninstall = undefined
  interceptor = undefined
  window.fetch = originalFetch
})

describe('fetch —— 放行路径', () => {
  it('安全方法直接透传，不打扰用户', async () => {
    const { confirm } = setup()

    await fetch('/api/users')

    expect(confirm).not.toHaveBeenCalled()
    expect(sent).toEqual([{ method: 'GET', url: '/api/users' }])
  })

  it('非 Agent 发起的写请求不拦——用户自己点的不归闸门管', async () => {
    const { confirm } = setup({ attribution: createStaticAttribution(false) })

    await fetch('/api/users/u_1', { method: 'DELETE' })

    expect(confirm).not.toHaveBeenCalled()
    expect(sent).toHaveLength(1)
  })

  it('命中放行名单的写请求直接透传', async () => {
    const { confirm } = setup({}, {
      allow: [{ id: 'search', match: { method: 'POST', url: '/api/*/search' } }]
    })

    await fetch('/api/users/search', { method: 'POST' })

    expect(confirm).not.toHaveBeenCalled()
    expect(sent).toHaveLength(1)
  })
})

describe('fetch —— 确认路径', () => {
  it('默认拒绝：未命中名单的写请求要确认', async () => {
    const { confirm } = setup()

    await fetch('/api/users/u_1', { method: 'DELETE' })

    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm.mock.calls[0][0]).toMatchObject({
      risk: 'write',
      request: { method: 'DELETE', url: expect.stringContaining('/api/users/u_1') }
    })
  })

  it('批准后才真正发出——顺序不能反', async () => {
    setup()

    await fetch('/api/users/u_1', { method: 'DELETE' })

    expect(sent).toEqual([{ method: 'DELETE', url: '/api/users/u_1' }])
  })

  it('拒绝时请求根本不发出', async () => {
    const confirm = vi.fn(async () => false)
    setup({ confirm })

    await expect(fetch('/api/users/u_1', { method: 'DELETE' })).rejects.toThrow()
    expect(sent).toHaveLength(0)
  })

  it('拒绝抛出可分辨的错误，而不是静默丢弃', async () => {
    // 调用方需要能区分「被用户拒了」和「网络挂了」——这与核心包用 cancelled 标记
    // 而非文案判定取消是同一条原则。
    setup({ confirm: vi.fn(async () => false) })

    await expect(fetch('/api/x', { method: 'POST' }))
      .rejects.toBeInstanceOf(RequestDeniedError)
  })

  it('危险名单升级为 destructive', async () => {
    const { confirm } = setup({}, {
      danger: [{ id: 'del-user', match: { method: 'DELETE', url: '/api/users/:id' } }]
    })

    await fetch('/api/users/u_1', { method: 'DELETE' })

    expect(confirm.mock.calls[0][0].risk).toBe('destructive')
  })

  it('相对 URL 先绝对化再匹配完整地址的危险 GET', async () => {
    const confirm = vi.fn(async () => false)
    setup({ confirm }, {
      danger: [{
        id: 'export-all',
        match: { method: 'GET', url: `${location.origin}/api/export-all` }
      }]
    })

    await expect(fetch('/api/export-all')).rejects.toBeInstanceOf(RequestDeniedError)

    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({
      risk: 'destructive',
      request: expect.objectContaining({ url: `${location.origin}/api/export-all` })
    }))
    expect(sent).toHaveLength(0)
  })

  it('已授权窗口内不重复确认——路径 A 已经问过人了', async () => {
    const scope = { begin: vi.fn(), end: vi.fn(), isAuthorized: () => true }
    const { confirm } = setup({ authorization: scope })

    await fetch('/api/users/u_1', { method: 'DELETE' })

    expect(confirm).not.toHaveBeenCalled()
    expect(sent).toHaveLength(1)
  })
})

describe('fetch —— 请求解析', () => {
  it('解析 JSON 请求体供规则判定', async () => {
    const seen: unknown[] = []
    setup({}, {
      danger: [{
        id: 'forced', match: { when: request => { seen.push(request.body); return false } }
      }]
    })

    await fetch('/api/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ force: true })
    })

    expect(seen[0]).toEqual({ force: true })
  })

  it('非 JSON 请求体保持原样，不因解析失败而中断', async () => {
    const seen: unknown[] = []
    setup({}, {
      danger: [{ id: 'x', match: { when: r => { seen.push(r.body); return false } } }]
    })

    await fetch('/api/x', { method: 'POST', body: 'name=zhangsan' })

    expect(seen[0]).toBe('name=zhangsan')
  })

  it('Request 对象形态同样能解析出方法与 URL', async () => {
    const { confirm } = setup()

    await fetch(new Request('https://app.test/api/users/u_1', { method: 'DELETE' }))

    expect(confirm.mock.calls[0][0].request).toMatchObject({
      method: 'DELETE',
      url: expect.stringContaining('/api/users/u_1')
    })
  })

  it('Request 自带 body 参与危险规则判定，不能被宽泛放行规则绕过', async () => {
    const confirm = vi.fn(async () => false)
    setup({ confirm }, {
      danger: [{
        id: 'forced-action',
        match: {
          method: 'POST',
          url: '/api/actions',
          when: request => (request.body as { force?: boolean })?.force === true
        }
      }],
      allow: [{ id: 'allow-api', match: { method: 'POST', url: '/api/**' } }]
    })
    const input = new Request('https://app.test/api/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ force: true })
    })

    await expect(fetch(input)).rejects.toBeInstanceOf(RequestDeniedError)

    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({
      risk: 'destructive',
      request: expect.objectContaining({ body: { force: true } })
    }))
    expect(sent).toHaveLength(0)
  })

  it.each([
    ['undefined', undefined],
    ['null', null]
  ] as const)('init.body 为 %s 时仍沿用 Request 自带 body', async (_label, body) => {
    const confirm = vi.fn(async () => false)
    setup({ confirm }, {
      danger: [{
        id: 'forced-action',
        match: {
          method: 'POST',
          url: '/api/actions',
          when: request => (request.body as { force?: boolean })?.force === true
        }
      }],
      allow: [{ id: 'allow-api', match: { method: 'POST', url: '/api/**' } }]
    })
    const input = new Request('https://app.test/api/actions', {
      method: 'POST',
      body: JSON.stringify({ force: true })
    })

    await expect(fetch(input, { body })).rejects.toBeInstanceOf(RequestDeniedError)

    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({
      risk: 'destructive',
      request: expect.objectContaining({ body: { force: true } })
    }))
    expect(sent).toHaveLength(0)
  })

  it('跨 realm Request 仍按真实方法、URL 与 headers 判定', async () => {
    const input = new Request('https://app.test/api/users/u_1', {
      method: 'DELETE',
      headers: { 'x-operation-id': 'op-1' }
    })
    const confirm = vi.fn(async () => false)
    vi.stubGlobal('Request', class OtherRealmRequest {})
    vi.stubGlobal('Headers', class OtherRealmHeaders {})

    try {
      setup({ confirm })

      await expect(fetch(input)).rejects.toBeInstanceOf(RequestDeniedError)

      expect(confirm).toHaveBeenCalledWith(expect.objectContaining({
        request: expect.objectContaining({
          method: 'DELETE',
          url: 'https://app.test/api/users/u_1',
          headers: { 'x-operation-id': 'op-1' }
        })
      }))
      expect(sent).toHaveLength(0)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('Request body 无法克隆读取时从严失败，不继续判定或发送', async () => {
    const input = new Request('https://app.test/api/actions', {
      method: 'POST',
      body: JSON.stringify({ force: true })
    })
    const cloneError = new Error('body unavailable')
    vi.spyOn(input, 'clone').mockImplementation(() => { throw cloneError })
    const { confirm } = setup()

    await expect(fetch(input)).rejects.toBe(cloneError)

    expect(confirm).not.toHaveBeenCalled()
    expect(sent).toHaveLength(0)
  })

  it('Request body 文本读取失败时从严失败，不继续判定或发送', async () => {
    const input = new Request('https://app.test/api/actions', {
      method: 'POST',
      body: JSON.stringify({ force: true })
    })
    const readError = new Error('body read failed')
    const clone = input.clone()
    vi.spyOn(clone, 'text').mockRejectedValue(readError)
    vi.spyOn(input, 'clone').mockReturnValue(clone)
    const { confirm } = setup()

    await expect(fetch(input)).rejects.toBe(readError)

    expect(confirm).not.toHaveBeenCalled()
    expect(sent).toHaveLength(0)
  })

  it('读取 Request body 供判定时不消费或改写原 fetch 调用', async () => {
    let bodyUsedBeforeOriginalFetch: boolean | undefined
    let bodyReceivedByOriginalFetch: string | undefined
    let inputReceivedByOriginalFetch: RequestInfo | URL | undefined
    let initReceivedByOriginalFetch: RequestInit | undefined
    let thisReceivedByOriginalFetch: unknown
    let argumentCount = 0
    window.fetch = vi.fn(async function (
      this: unknown,
      input: RequestInfo | URL,
      init?: RequestInit
    ) {
      inputReceivedByOriginalFetch = input
      initReceivedByOriginalFetch = init
      thisReceivedByOriginalFetch = this
      argumentCount = arguments.length
      if (input instanceof Request) {
        bodyUsedBeforeOriginalFetch = input.bodyUsed
        bodyReceivedByOriginalFetch = await input.text()
      }
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    const bodiesSeenByPolicy: unknown[] = []
    setup({}, {
      danger: [{
        id: 'inspect-body',
        match: {
          method: 'POST',
          when: request => {
            bodiesSeenByPolicy.push(request.body)
            return false
          }
        }
      }],
      allow: [{ id: 'allow-api', match: { method: 'POST', url: '/api/**' } }]
    })
    const rawBody = JSON.stringify({ force: false })
    const input = new Request('https://app.test/api/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: rawBody
    })
    const init: RequestInit = { headers: { 'x-call-id': 'call-1' } }
    const callContext = { source: 'test' }

    expect(input.bodyUsed).toBe(false)
    await Reflect.apply(window.fetch, callContext, [input, init])

    expect(bodiesSeenByPolicy).toEqual([{ force: false }])
    expect(bodyUsedBeforeOriginalFetch).toBe(false)
    expect(bodyReceivedByOriginalFetch).toBe(rawBody)
    expect(inputReceivedByOriginalFetch).toBe(input)
    expect(initReceivedByOriginalFetch).toBe(init)
    expect(thisReceivedByOriginalFetch).toBe(callContext)
    expect(argumentCount).toBe(2)
  })
})

describe('透传与生命周期', () => {
  it('保留原始 fetch 的返回值', async () => {
    setup()

    const response = await fetch('/api/users')

    expect(response.status).toBe(200)
  })

  it('原始 fetch 抛错时原样抛出，不吞掉', async () => {
    window.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch') }) as typeof fetch
    setup()

    await expect(fetch('/api/users')).rejects.toThrow('Failed to fetch')
  })

  it('卸载后完全还原', () => {
    const before = window.fetch
    setup()
    expect(window.fetch).not.toBe(before)

    uninstall?.()
    uninstall = undefined

    expect(window.fetch).toBe(before)
  })

  it('重复安装是幂等的，不叠加多层 patch', async () => {
    const { confirm } = setup()
    const second = interceptor?.install()

    await fetch('/api/x', { method: 'POST' })
    second?.()

    // 叠了两层的话会判定两次
    expect(confirm).toHaveBeenCalledTimes(1)
  })

  it('installed 反映当前状态', () => {
    setup()
    expect(interceptor?.installed).toBe(true)

    uninstall?.()
    uninstall = undefined

    expect(interceptor?.installed).toBe(false)
  })

  it('先卸载旧 Fetch 实例只移除该层，最后卸载恢复基线函数', async () => {
    const baselineFetch = window.fetch
    const order: string[] = []
    const confirmA = vi.fn<ConfirmRequestHandler>(
      async () => { order.push('A'); return true }
    )
    const confirmB = vi.fn<ConfirmRequestHandler>(
      async () => { order.push('B'); return true }
    )
    const instanceA = createInterceptor({
      policy: {},
      attribution: createStaticAttribution(true),
      confirm: confirmA,
      channels: ['fetch']
    })
    const instanceB = createInterceptor({
      policy: {},
      attribution: createStaticAttribution(true),
      confirm: confirmB,
      channels: ['fetch']
    })
    const uninstallA = instanceA.install()
    const uninstallB = instanceB.install()

    try {
      await fetch('/api/users/u_1', { method: 'DELETE' })
      expect(order).toEqual(['B', 'A'])

      confirmA.mockClear()
      confirmB.mockClear()
      order.length = 0
      sent = []
      confirmB.mockResolvedValueOnce(false)
      uninstallA()

      await expect(fetch('/api/users/u_2', { method: 'DELETE' }))
        .rejects.toBeInstanceOf(RequestDeniedError)
      expect(order).toEqual([])
      expect(confirmB).toHaveBeenCalledTimes(1)
      expect(confirmA).not.toHaveBeenCalled()
      expect(sent).toHaveLength(0)

      uninstallB()
      expect(window.fetch).toBe(baselineFetch)
    } finally {
      uninstallB()
      uninstallA()
      window.fetch = baselineFetch
    }
  })

  it('按 LIFO 卸载 Fetch 实例时保留前一激活层', async () => {
    const baselineFetch = window.fetch
    const confirmA = vi.fn(async () => true)
    const confirmB = vi.fn(async () => true)
    const instanceA = createInterceptor({
      policy: {},
      attribution: createStaticAttribution(true),
      confirm: confirmA,
      channels: ['fetch']
    })
    const instanceB = createInterceptor({
      policy: {},
      attribution: createStaticAttribution(true),
      confirm: confirmB,
      channels: ['fetch']
    })
    const uninstallA = instanceA.install()
    const wrapperA = window.fetch
    const uninstallB = instanceB.install()

    try {
      uninstallB()
      expect(window.fetch).toBe(wrapperA)

      await fetch('/api/users/u_1', { method: 'DELETE' })
      expect(confirmA).toHaveBeenCalledTimes(1)
      expect(confirmB).not.toHaveBeenCalled()

      uninstallA()
      expect(window.fetch).toBe(baselineFetch)
    } finally {
      uninstallB()
      uninstallA()
      window.fetch = baselineFetch
    }
  })

  it('卸载 Fetch 实例不覆盖后安装的外部 wrapper，旧引用只透明透传', async () => {
    const baselineFetch = window.fetch
    const confirmA = vi.fn(async () => true)
    const instanceA = createInterceptor({
      policy: {},
      attribution: createStaticAttribution(true),
      confirm: confirmA,
      channels: ['fetch']
    })
    const uninstallA = instanceA.install()
    const interceptedFetch = window.fetch
    const externalFetch = vi.fn(function (
      this: unknown,
      ...args: Parameters<typeof fetch>
    ) {
      return interceptedFetch.apply(this, args)
    }) as typeof fetch
    window.fetch = externalFetch

    try {
      uninstallA()

      expect(window.fetch).toBe(externalFetch)
      await fetch('/api/users/u_1', { method: 'DELETE' })
      expect(externalFetch).toHaveBeenCalledTimes(1)
      expect(confirmA).not.toHaveBeenCalled()
      expect(sent).toHaveLength(1)
    } finally {
      window.fetch = baselineFetch
      uninstallA()
    }
  })

  it('外部同名 patch 元数据读取抛错时仍把它当作恢复边界', () => {
    const baselineFetch = window.fetch
    const metadataSymbol = Symbol.for('@wandkit/interceptor.patch')
    const externalFetch = vi.fn(async () => new Response('{}', { status: 200 })) as typeof fetch
    Object.defineProperty(externalFetch, metadataSymbol, {
      get() { throw new Error('metadata denied') }
    })
    window.fetch = externalFetch
    const instanceA = createInterceptor({
      policy: {},
      attribution: createStaticAttribution(true),
      confirm: vi.fn(async () => true),
      channels: ['fetch']
    })
    const uninstallA = instanceA.install()

    try {
      expect(() => uninstallA()).not.toThrow()
      expect(window.fetch).toBe(externalFetch)
    } finally {
      window.fetch = baselineFetch
      uninstallA()
    }
  })
})

describe('闸门自身出错时从严', () => {
  it('confirm 回调抛错按拒绝处理——问不出结果不等于放行', async () => {
    setup({ confirm: vi.fn(async () => { throw new Error('弹窗挂了') }) })

    await expect(fetch('/api/x', { method: 'POST' })).rejects.toBeInstanceOf(RequestDeniedError)
    expect(sent).toHaveLength(0)
  })

  it('归属判定抛错时按 Agent 发起处理，走完整闸门', async () => {
    const { confirm } = setup({
      attribution: { isAgentActive: () => { throw new Error('遮罩状态未知') } }
    })

    await fetch('/api/x', { method: 'POST' })

    expect(confirm).toHaveBeenCalled()
  })
})

describe('判定回调', () => {
  it('每次判定都上报，供宿主写入 trace', async () => {
    const onVerdict = vi.fn()
    setup({ onVerdict })

    await fetch('/api/users')
    await fetch('/api/x', { method: 'POST' })

    expect(onVerdict).toHaveBeenCalledTimes(2)
    expect(onVerdict.mock.calls[0][1]).toMatchObject({ action: 'allow' })
    expect(onVerdict.mock.calls[1][1]).toMatchObject({ action: 'confirm' })
  })

  it('describe 产出的披露信息传给确认回调', async () => {
    const { confirm } = setup({}, {
      danger: [{
        id: 'del',
        match: { method: 'DELETE' },
        describe: async () => ({
          title: '删除用户', rows: [{ label: '用户', value: '张三' }], impact: '不可恢复'
        })
      }]
    })

    await fetch('/api/users/u_1', { method: 'DELETE' })

    expect(confirm.mock.calls[0][0].disclosure).toMatchObject({ title: '删除用户' })
  })
})
