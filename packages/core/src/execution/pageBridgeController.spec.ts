import { afterEach, describe, expect, it, vi } from 'vitest'
import { PageAdapterRegistry } from './pageAdapterRegistry'
import { createPageBridgeController } from './pageBridgeController'

function createHarness(requestId: string | null = null) {
  const registry = new PageAdapterRegistry(100)
  let routeRequestId = requestId
  const unregister = vi.fn()
  const registerAdapter = vi.fn(() => unregister)
  const clearRequestId = vi.fn((value: string) => {
    if (routeRequestId === value) routeRequestId = null
  })
  const onFallback = vi.fn()
  const onPageQueryStart = vi.fn()
  const onPageQuerySettled = vi.fn()
  const controller = createPageBridgeController({
    registry,
    moduleId: 'customer',
    routeName: 'Customer-managemnet',
    fallbackDelayMs: 50,
    registerAdapter,
    getRequestId: () => routeRequestId,
    clearRequestId,
    onFallback,
    onPageQueryStart,
    onPageQuerySettled
  })
  return {
    registry,
    controller,
    registerAdapter,
    unregister,
    clearRequestId,
    onFallback,
    onPageQueryStart,
    onPageQuerySettled
  }
}

describe('Page Bridge Controller', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('重复进入页面只注册一次 Adapter', () => {
    const harness = createHarness()

    expect(harness.controller.enter()).toBe(false)
    expect(harness.controller.enter()).toBe(false)

    expect(harness.registerAdapter).toHaveBeenCalledTimes(1)
  })

  it('观察跨路由请求完成并清理路由 requestId', () => {
    const harness = createHarness('request-1')
    harness.registry.beginRequestAwaitingPageObserver(
      'customer',
      'Customer-managemnet',
      'request-1'
    )

    expect(harness.controller.enter()).toBe(true)
    harness.registry.completeRequest('customer', 'Customer-managemnet', 'request-1')

    expect(harness.clearRequestId).toHaveBeenCalledWith('request-1')
    expect(harness.onFallback).not.toHaveBeenCalled()
  })

  it('跨路由请求失败时回退到页面原始加载，避免页面留空白', () => {
    const harness = createHarness('request-fail')
    harness.registry.beginRequestAwaitingPageObserver(
      'customer',
      'Customer-managemnet',
      'request-fail'
    )

    expect(harness.controller.enter()).toBe(true)
    harness.registry.failRequest('customer', 'Customer-managemnet', 'request-fail')

    expect(harness.clearRequestId).toHaveBeenCalledWith('request-fail')
    // 失败终态必须触发页面原始加载，否则页面既跳过了自身 getList 又拿不到 Agent 结果
    expect(harness.onFallback).toHaveBeenCalledTimes(1)
  })

  it('请求被更新的请求接管而失效时不回退，避免与新请求相互覆盖', () => {
    const registry = new PageAdapterRegistry(100)
    let routeRequestId: string | null = 'request-old'
    const onFallback = vi.fn()
    const controller = createPageBridgeController({
      registry,
      moduleId: 'customer',
      routeName: 'Customer-managemnet',
      fallbackDelayMs: 50,
      registerAdapter: () => () => undefined,
      getRequestId: () => routeRequestId,
      clearRequestId: value => {
        if (routeRequestId === value) routeRequestId = null
      },
      onFallback,
      onPageQueryStart: () => undefined,
      onPageQuerySettled: () => undefined
    })
    registry.beginRequestAwaitingPageObserver('customer', 'Customer-managemnet', 'request-old')
    expect(controller.enter()).toBe(true)

    // 更新的请求已接管路由（requestId 切到新值），旧请求随后失效
    routeRequestId = 'request-new'
    registry.invalidateRequest('customer', 'Customer-managemnet', 'request-old')

    expect(onFallback).not.toHaveBeenCalled()
  })

  it('请求记录缺失时超时回退到页面原始加载', () => {
    vi.useFakeTimers()
    const harness = createHarness('missing-request')

    expect(harness.controller.enter()).toBe(true)
    vi.advanceTimersByTime(50)

    expect(harness.clearRequestId).toHaveBeenCalledWith('missing-request')
    expect(harness.onFallback).toHaveBeenCalledTimes(1)
  })

  it('拒绝非当前页面同步请求', () => {
    const harness = createHarness('request-2')
    harness.registry.beginRequest('customer', 'Customer-managemnet', 'request-2')

    expect(() => harness.controller.prepareApply('expired-request'))
      .toThrow('Page sync request is no longer current')
  })

  it('应用 Agent 结果后忽略更早发起的页面查询响应', async() => {
    const harness = createHarness('request-3')
    harness.registry.beginRequest('customer', 'Customer-managemnet', 'request-3')
    let resolveQuery: (value: string) => void = () => undefined
    const request = new Promise<string>((resolve) => {
      resolveQuery = resolve
    })
    const apply = vi.fn()
    const pending = harness.controller.runLatestQuery(() => request, apply)

    harness.controller.prepareApply('request-3')
    resolveQuery('旧列表')
    await pending

    expect(apply).not.toHaveBeenCalled()
    expect(harness.onPageQueryStart).toHaveBeenCalledTimes(1)
    expect(harness.onPageQuerySettled).toHaveBeenCalledTimes(1)
  })

  it('离开页面时注销 Adapter、终止页面查询并失效当前请求', () => {
    const harness = createHarness('request-4')
    harness.registry.beginRequest('customer', 'Customer-managemnet', 'request-4')
    harness.controller.enter()

    harness.controller.leave()

    expect(harness.unregister).toHaveBeenCalledTimes(1)
    expect(harness.onPageQuerySettled).toHaveBeenCalledTimes(1)
    expect(harness.registry.isLatestRequest(
      'customer',
      'Customer-managemnet',
      'request-4'
    )).toBe(false)
  })
})
