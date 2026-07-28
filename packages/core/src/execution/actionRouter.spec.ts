import { Type } from '@sinclair/typebox'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PageAdapter } from '../contracts/pageAdapter'
import type { PreparedAction, ToolResult, UiEffect } from '../contracts/result'
import type { ToolDefinition, ToolExecutionContext } from '../contracts/tool'
import { defineNavigationTool, defineReadTool, defineWriteTool } from '../contracts/tool'
import { ActionRouter } from './actionRouter'
import { NavigationCoordinator, type RouterPort } from './navigationCoordinator'
import { PageAdapterRegistry } from './pageAdapterRegistry'
import { defaultMessages } from '../config/messages'

const routeName = 'Gateway-managemnet'
const requestId = 'request-7'
const context: ToolExecutionContext = {
  runId: 'run-7',
  traceId: 'trace-7',
  permissions: [],
  activateModules: vi.fn()
}

interface ToolResultResolver {
  (result: ToolResult): void
}

function createAdapter(effectSpy = vi.fn()): PageAdapter {
  return {
    moduleId: 'gateway',
    routeName,
    getContext: () => ({}),
    applyUiEffect: effectSpy
  }
}

function createRouterPort(overrides: Partial<RouterPort> = {}): RouterPort {
  return {
    getCurrentRouteName: () => undefined,
    push: vi.fn().mockResolvedValue(undefined),
    ...overrides
  }
}

function createActionRouter(
  registry: PageAdapterRegistry,
  routerPort = createRouterPort(),
  timeoutMs = 30
): ActionRouter {
  return new ActionRouter({
    adapters: registry,
    navigation: new NavigationCoordinator(routerPort, registry, timeoutMs),
    resolveRouteName: () => routeName
  })
}

const showQueryEffect: UiEffect = {
  type: 'gateway:show-query',
  payload: { gatewayName: 'CPV2' }
}

function requestRecordCount(registry: PageAdapterRegistry): number {
  const records = (
    registry as unknown as {
      requestRecords: Map<string, Map<string, unknown>>
    }
  ).requestRecords
  return [...records.values()].reduce((total, routeRecords) => {
    return total + routeRecords.size
  }, 0)
}

describe('PageAdapterRegistry', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('注册后可查询，注销函数只移除自己注册的实例', () => {
    const registry = new PageAdapterRegistry()
    const first = createAdapter()
    const second = createAdapter()
    const unregisterFirst = registry.register(first)

    expect(registry.get('gateway', routeName)).toBe(first)

    const previousNodeEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    const unregisterSecond = registry.register(second)
    process.env.NODE_ENV = previousNodeEnv

    unregisterFirst()
    expect(registry.get('gateway', routeName)).toBe(second)

    unregisterSecond()
    expect(registry.get('gateway', routeName)).toBeUndefined()
  })

  it('非生产环境拒绝重复注册同一模块与路由', () => {
    const registry = new PageAdapterRegistry()
    registry.register(createAdapter())

    expect(() => registry.register(createAdapter()))
      .toThrow('Duplicate page adapter: gateway/Gateway-managemnet')
  })

  it('waitFor 在页面注册后返回 Adapter', async() => {
    const registry = new PageAdapterRegistry()
    const adapter = createAdapter()
    const waiting = registry.waitFor('gateway', routeName, requestId, 50)

    registry.register(adapter)

    await expect(waiting).resolves.toBe(adapter)
  })

  it('waitFor 超时时返回包含 requestId 的确定性错误', async() => {
    const registry = new PageAdapterRegistry()

    await expect(registry.waitFor('gateway', routeName, requestId, 5))
      .rejects.toThrow('Timed out waiting for page: gateway/Gateway-managemnet (request-7)')
  })

  it('只有最新页面同步请求可以完成', () => {
    const registry = new PageAdapterRegistry()

    registry.beginRequest('gateway', routeName, 'request-A')
    expect(registry.isLatestRequest('gateway', routeName, 'request-A')).toBe(true)

    registry.beginRequest('gateway', routeName, 'request-B')
    expect(registry.isLatestRequest('gateway', routeName, 'request-A')).toBe(false)
    expect(registry.isLatestRequest('gateway', routeName, 'request-B')).toBe(true)

    registry.completeRequest('gateway', routeName, 'request-A')
    expect(registry.isLatestRequest('gateway', routeName, 'request-B')).toBe(true)

    registry.completeRequest('gateway', routeName, 'request-B')
    expect(registry.isLatestRequest('gateway', routeName, 'request-B')).toBe(false)
  })

  it('页面兜底失效请求后迟到结果不再是最新', () => {
    const registry = new PageAdapterRegistry()

    registry.beginRequest('gateway', routeName, requestId)
    registry.invalidateRequest('gateway', routeName, requestId)

    expect(registry.isLatestRequest('gateway', routeName, requestId)).toBe(false)
  })

  it('页面离开时可以失效无 URL 的当前请求', () => {
    const registry = new PageAdapterRegistry()

    registry.beginRequest('gateway', routeName, requestId)
    registry.invalidateLatestRequest('gateway', routeName)

    expect(registry.isLatestRequest('gateway', routeName, requestId)).toBe(false)
  })

  it('页面可观察请求终态，且迟订阅也能消费已发生的终态', () => {
    const registry = new PageAdapterRegistry()
    const pendingListener = vi.fn()
    const lateListener = vi.fn()

    registry.beginRequest('gateway', routeName, 'request-pending')
    registry.observeRequest('gateway', routeName, 'request-pending', pendingListener)
    registry.failRequest('gateway', routeName, 'request-pending')
    registry.beginRequestAwaitingPageObserver('gateway', routeName, 'request-late')
    registry.failRequest('gateway', routeName, 'request-late')
    registry.observeRequest('gateway', routeName, 'request-late', lateListener)

    expect(pendingListener).toHaveBeenCalledWith('failed')
    expect(lateListener).toHaveBeenCalledWith('failed')
  })

  it('普通同路由请求终态立即清理，连续请求不增长', () => {
    const registry = new PageAdapterRegistry()

    for (let index = 0; index < 100; index += 1) {
      const currentRequestId = `request-${index}`
      registry.beginRequest('gateway', routeName, currentRequestId)
      registry.completeRequest('gateway', routeName, currentRequestId)
    }

    expect(requestRecordCount(registry)).toBe(0)
  })

  it('等待页面 observer 的终态可迟订阅消费，消费后立即清理', () => {
    const registry = new PageAdapterRegistry()
    const listener = vi.fn()

    registry.beginRequestAwaitingPageObserver(
      'gateway',
      routeName,
      requestId
    )
    registry.failRequest('gateway', routeName, requestId)
    registry.observeRequest('gateway', routeName, requestId, listener)

    expect(listener).toHaveBeenCalledWith('failed')
    expect(requestRecordCount(registry)).toBe(0)
  })

  it('等待页面 observer 退订或无人消费时，终态在 TTL 后回收', () => {
    vi.useFakeTimers()
    const registry = new PageAdapterRegistry(25)

    registry.beginRequestAwaitingPageObserver(
      'gateway',
      routeName,
      requestId
    )
    const unsubscribe = registry.observeRequest(
      'gateway',
      routeName,
      requestId,
      vi.fn()
    )
    unsubscribe()
    registry.failRequest('gateway', routeName, requestId)
    registry.beginRequestAwaitingPageObserver(
      'gateway',
      routeName,
      'request-no-observer'
    )
    registry.failRequest('gateway', routeName, 'request-no-observer')

    expect(requestRecordCount(registry)).toBe(2)
    vi.advanceTimersByTime(24)
    expect(requestRecordCount(registry)).toBe(2)
    vi.advanceTimersByTime(1)
    expect(requestRecordCount(registry)).toBe(0)
  })

  it('observer 异常彼此隔离，且不向终态 owner 冒泡', () => {
    const registry = new PageAdapterRegistry()
    const secondListener = vi.fn()
    registry.beginRequest('gateway', routeName, requestId)
    registry.observeRequest('gateway', routeName, requestId, () => {
      throw new Error('observer failed')
    })
    registry.observeRequest('gateway', routeName, requestId, secondListener)

    expect(() => {
      registry.completeRequest('gateway', routeName, requestId)
    }).not.toThrow()
    expect(secondListener).toHaveBeenCalledWith('completed')
    expect(requestRecordCount(registry)).toBe(0)
  })
})

describe('NavigationCoordinator', () => {
  it('导航时传递 requestId，并等待对应 Adapter', async() => {
    const registry = new PageAdapterRegistry()
    const adapter = createAdapter()
    const routerPort = createRouterPort()
    const navigation = new NavigationCoordinator(routerPort, registry, 50)

    const navigating = navigation.navigateAndWait('gateway', routeName, requestId)
    registry.register(adapter)

    await expect(navigating).resolves.toBe(adapter)
    expect(routerPort.push).toHaveBeenCalledWith({
      name: routeName,
      query: { airlockRequestId: requestId }
    })
  })

  it('当前已是目标路由时忽略 NavigationDuplicated', async() => {
    const registry = new PageAdapterRegistry()
    const adapter = createAdapter()
    registry.register(adapter)
    const duplicated = Object.assign(new Error('duplicated'), { name: 'NavigationDuplicated' })
    const routerPort = createRouterPort({
      getCurrentRouteName: () => routeName,
      push: vi.fn().mockRejectedValue(duplicated)
    })

    await expect(new NavigationCoordinator(routerPort, registry).navigateAndWait(
      'gateway', routeName, requestId
    )).resolves.toBe(adapter)
  })

  it('非同路由 NavigationDuplicated 与其他导航错误均向上抛出', async() => {
    const duplicated = Object.assign(new Error('duplicated'), { name: 'NavigationDuplicated' })
    const registry = new PageAdapterRegistry()
    const differentRoute = createRouterPort({
      getCurrentRouteName: () => 'Dashboard',
      push: vi.fn().mockRejectedValue(duplicated)
    })
    const failed = createRouterPort({
      push: vi.fn().mockRejectedValue(new Error('router failed'))
    })

    await expect(new NavigationCoordinator(differentRoute, registry).navigateAndWait(
      'gateway', routeName, requestId
    )).rejects.toThrow('duplicated')
    await expect(new NavigationCoordinator(failed, registry).navigateAndWait(
      'gateway', routeName, requestId
    )).rejects.toThrow('router failed')
  })
})

describe('ActionRouter A+B 执行通道', () => {
  it('已 abort 的 page 工具不导航、不执行、不应用页面效果', async() => {
    const controller = new AbortController()
    controller.abort()
    const applyUiEffect = vi.fn()
    const execute = vi.fn().mockResolvedValue({
      ok: true, message: 'opened', uiEffect: showQueryEffect
    })
    const registry = new PageAdapterRegistry()
    registry.register(createAdapter(applyUiEffect))
    const routerPort = createRouterPort()
    const tool = defineNavigationTool({
      moduleId: 'gateway', name: 'open-aborted', version: 1, title: '打开', description: '打开', aliases: [],
      risk: 'navigation', executionMode: 'page', schema: Type.Object({}), execute
    })

    await expect(createActionRouter(registry, routerPort).execute({
      tool,
      context: { ...context, signal: controller.signal },
      input: {},
      requestId
    })).resolves.toEqual({ ok: false, message: defaultMessages.cancelled, cancelled: true })
    expect(routerPort.push).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
    expect(applyUiEffect).not.toHaveBeenCalled()
  })

  it('执行前已 abort 的写工具不发起请求', async() => {
    const controller = new AbortController()
    controller.abort()
    const execute = vi.fn()
    const tool = defineWriteTool({
      moduleId: 'gateway', name: 'aborted-write', version: 1, title: '更新', description: '更新', aliases: [],
      risk: 'write', executionMode: 'global', schema: Type.Object({}), prepare: vi.fn(), execute
    })

    await expect(createActionRouter(new PageAdapterRegistry()).execute({
      tool,
      context: { ...context, signal: controller.signal },
      input: undefined,
      prepared: { title: '确认', rows: [], payload: { id: 1 }},
      requestId
    })).resolves.toEqual({ ok: false, message: defaultMessages.cancelled, cancelled: true })
    expect(execute).not.toHaveBeenCalled()
  })

  it('写请求已发出后 stop，真实成功结果不被改成取消', async() => {
    const controller = new AbortController()
    let finishExecute: ((result: ToolResult) => void) | undefined
    let markStarted: (() => void) | undefined
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const execute = vi.fn(() => new Promise<ToolResult>(resolve => {
      finishExecute = resolve
      markStarted?.()
    }))
    const tool = defineWriteTool({
      moduleId: 'gateway', name: 'slow-write-success', version: 1, title: '更新', description: '更新', aliases: [],
      risk: 'write', executionMode: 'global', schema: Type.Object({}), prepare: vi.fn(), execute
    })
    const executing = createActionRouter(new PageAdapterRegistry()).execute({
      tool,
      context: { ...context, signal: controller.signal },
      input: undefined,
      prepared: { title: '确认', rows: [], payload: { id: 1 }},
      requestId
    })
    await started

    controller.abort()
    finishExecute?.({
      ok: true,
      message: '更新成功',
      writeState: 'committed'
    })

    await expect(executing).resolves.toEqual({
      ok: true,
      message: '更新成功',
      writeState: 'committed'
    })
  })

  it('读请求 stop 后抛 AbortError 仍返回确定取消', async() => {
    const controller = new AbortController()
    let rejectExecute: ((error: Error) => void) | undefined
    let markStarted: (() => void) | undefined
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const tool = defineReadTool({
      moduleId: 'gateway', name: 'slow-read-abort', version: 1, title: '查询', description: '查询', aliases: [],
      risk: 'read', executionMode: 'global', schema: Type.Object({}),
      execute: () => new Promise<ToolResult>((_resolve, reject) => {
        rejectExecute = reject
        markStarted?.()
      })
    })
    const executing = createActionRouter(new PageAdapterRegistry()).execute({
      tool,
      context: { ...context, signal: controller.signal },
      input: {},
      requestId
    })
    await started

    controller.abort()
    const error = new Error('aborted')
    error.name = 'AbortError'
    rejectExecute?.(error)

    await expect(executing).resolves.toEqual({ ok: false, message: defaultMessages.cancelled, cancelled: true })
  })

  it.each(['failed', 'aborted'] as const)(
    '写请求已发出后 stop，%s 结果标记为未知态',
    async(outcome) => {
      const controller = new AbortController()
      let finishExecute: ((result: ToolResult) => void) | undefined
      let rejectExecute: ((error: Error) => void) | undefined
      let markStarted: (() => void) | undefined
      const started = new Promise<void>(resolve => { markStarted = resolve })
      const execute = vi.fn(() => new Promise<ToolResult>((resolve, reject) => {
        finishExecute = resolve
        rejectExecute = reject
        markStarted?.()
      }))
      const tool = defineWriteTool({
        moduleId: 'gateway', name: 'slow-write-unknown', version: 1, title: '更新', description: '更新', aliases: [],
        risk: 'write', executionMode: 'global', schema: Type.Object({}), prepare: vi.fn(), execute
      })
      const executing = createActionRouter(new PageAdapterRegistry()).execute({
        tool,
        context: { ...context, signal: controller.signal },
        input: undefined,
        prepared: { title: '确认', rows: [], payload: { id: 1 }},
        requestId
      })
      await started

      controller.abort()
      if (outcome === 'failed') {
        finishExecute?.({ ok: false, message: '后端失败' })
      } else {
        const error = new Error('aborted')
        error.name = 'AbortError'
        rejectExecute?.(error)
      }

      await expect(executing).resolves.toEqual({
        ok: false,
        message: defaultMessages.writeStateUnknown,
        writeState: 'unknown'
      })
    }
  )

  it('写入已 committed 但 refresh 被 stop 时保留明确结果', async() => {
    const controller = new AbortController()
    let finishExecute: ((result: ToolResult) => void) | undefined
    let markStarted: (() => void) | undefined
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const tool = defineWriteTool({
      moduleId: 'gateway', name: 'committed-refresh-abort', version: 1,
      title: '更新', description: '更新', aliases: [], risk: 'write', executionMode: 'global',
      schema: Type.Object({}), prepare: vi.fn(),
      execute: () => new Promise<ToolResult>(resolve => {
        finishExecute = resolve
        markStarted?.()
      })
    })
    const executing = createActionRouter(new PageAdapterRegistry()).execute({
      tool,
      context: { ...context, signal: controller.signal },
      input: undefined,
      prepared: { title: '确认', rows: [], payload: { id: 1 }},
      requestId
    })
    await started

    controller.abort()
    finishExecute?.({
      ok: false,
      message: '写入成功，但刷新线路运行时失败：aborted。请勿重复提交，请手动刷新或联系管理员。',
      writeState: 'committed'
    })

    await expect(executing).resolves.toEqual({
      ok: false,
      message: '写入成功，但刷新线路运行时失败：aborted。请勿重复提交，请手动刷新或联系管理员。',
      writeState: 'committed'
    })
  })

  it.each(['global', 'page'] as const)(
    '写请求成功后在 %s UiEffect 期间 stop 仍保留真实成功',
    async(executionMode) => {
      const controller = new AbortController()
      let rejectEffect: ((error: Error) => void) | undefined
      let markEffectStarted: (() => void) | undefined
      const effectStarted = new Promise<void>(resolve => { markEffectStarted = resolve })
      const applyUiEffect = vi.fn(() => new Promise<void>((_resolve, reject) => {
        rejectEffect = reject
        markEffectStarted?.()
      }))
      const registry = new PageAdapterRegistry()
      registry.register(createAdapter(applyUiEffect))
      const tool = defineWriteTool({
        moduleId: 'gateway', name: `effect-${executionMode}`, version: 1,
        title: '更新', description: '更新', aliases: [], risk: 'write', executionMode,
        schema: Type.Object({}), prepare: vi.fn(),
        execute: vi.fn().mockResolvedValue({
          ok: true,
          message: '更新成功',
          uiEffect: showQueryEffect
        })
      })
      const executing = createActionRouter(registry).execute({
        tool,
        context: { ...context, signal: controller.signal },
        input: undefined,
        prepared: { title: '确认', rows: [], payload: { id: 1 }},
        requestId
      })
      await effectStarted

      controller.abort()
      const error = new Error('aborted effect')
      error.name = 'AbortError'
      rejectEffect?.(error)

      await expect(executing).resolves.toEqual({
        ok: true,
        message: '更新成功',
        uiEffect: showQueryEffect
      })
    }
  )

  it('global 工具不依赖页面，无 UiEffect 时直接返回结果', async() => {
    const execute = vi.fn().mockResolvedValue({ ok: true, message: 'queried' })
    const tool = defineReadTool({
      moduleId: 'gateway', name: 'query', version: 1, title: '查询', description: '查询', aliases: [],
      risk: 'read', executionMode: 'global', schema: Type.Object({ keyword: Type.String() }), execute
    })
    const registry = new PageAdapterRegistry()
    const routerPort = createRouterPort()

    await expect(createActionRouter(registry, routerPort).execute({
      tool, context, input: { keyword: 'CPV2' }, requestId
    })).resolves.toEqual({ ok: true, message: 'queried' })
    expect(execute).toHaveBeenCalledWith(context, { keyword: 'CPV2' })
    expect(routerPort.push).not.toHaveBeenCalled()
  })

  it('global 工具在模块没有页面路由时仍可执行', async() => {
    const tool = createReadTool('global', { ok: true, message: 'queried' })
    const registry = new PageAdapterRegistry()
    const routerPort = createRouterPort()
    const actionRouter = new ActionRouter({
      adapters: registry,
      navigation: new NavigationCoordinator(routerPort, registry),
      resolveRouteName: () => undefined
    })

    await expect(actionRouter.execute({
      tool, context, input: {}, requestId
    })).resolves.toEqual({ ok: true, message: 'queried' })
    expect(routerPort.push).not.toHaveBeenCalled()
  })

  it('global 结果带 UiEffect 且目标 Adapter 已挂载时直接应用但不导航', async() => {
    const applyUiEffect = vi.fn()
    const registry = new PageAdapterRegistry()
    registry.register(createAdapter(applyUiEffect))
    const routerPort = createRouterPort()
    const tool = createReadTool('global', { ok: true, message: 'queried', uiEffect: showQueryEffect })

    const result = await createActionRouter(registry, routerPort).execute({
      tool, context, input: {}, requestId
    })

    expect(result.ok).toBe(true)
    expect(applyUiEffect).toHaveBeenCalledWith(showQueryEffect, requestId)
    expect(routerPort.push).not.toHaveBeenCalled()
  })

  it('工具完成时 signal 已取消则不应用过期 UiEffect', async() => {
    const controller = new AbortController()
    const applyUiEffect = vi.fn()
    const registry = new PageAdapterRegistry()
    registry.register(createAdapter(applyUiEffect))
    let resolveTool: ((result: ToolResult) => void) | undefined
    const tool = defineReadTool({
      moduleId: 'gateway', name: 'slow', version: 1, title: '慢查询', description: '慢查询', aliases: [],
      risk: 'read', executionMode: 'global', schema: Type.Object({}),
      execute: () => new Promise<ToolResult>(resolve => { resolveTool = resolve })
    })
    const executing = createActionRouter(registry).execute({
      tool,
      context: { ...context, signal: controller.signal },
      input: {},
      requestId
    })

    controller.abort()
    resolveTool?.({ ok: true, message: '过期结果', uiEffect: showQueryEffect })

    await expect(executing).resolves.toEqual({ ok: false, message: defaultMessages.cancelled, cancelled: true })
    expect(applyUiEffect).not.toHaveBeenCalled()
  })

  it('page 工具先导航等待 Adapter，再执行并传递 requestId 应用 UiEffect', async() => {
    const applyUiEffect = vi.fn()
    const registry = new PageAdapterRegistry()
    const routerPort = createRouterPort({
      push: vi.fn().mockImplementation(async() => {
        registry.register(createAdapter(applyUiEffect))
      })
    })
    const execute = vi.fn().mockResolvedValue({
      ok: true, message: 'opened', uiEffect: showQueryEffect
    })
    const tool = defineNavigationTool({
      moduleId: 'gateway', name: 'open', version: 1, title: '打开', description: '打开', aliases: [],
      risk: 'navigation', executionMode: 'page', schema: Type.Object({}), execute
    })

    const result = await createActionRouter(registry, routerPort).execute({
      tool, context, input: {}, requestId
    })

    expect(result.ok).toBe(true)
    expect(routerPort.push).toHaveBeenCalledWith({
      name: routeName,
      query: { airlockRequestId: requestId }
    })
    expect(execute).toHaveBeenCalledWith(context, {})
    expect(applyUiEffect).toHaveBeenCalledWith(showQueryEffect, requestId)
  })

  it('A 后发起 B 时，A 返回后不得覆盖 B 的页面同步', async() => {
    const applyUiEffect = vi.fn()
    const registry = new PageAdapterRegistry()
    registry.register(createAdapter(applyUiEffect))
    const resolvers = new Map<string, ToolResultResolver>()
    const tool = defineReadTool({
      moduleId: 'gateway', name: 'latest-query', version: 1,
      title: '查询', description: '查询', aliases: [], risk: 'read', executionMode: 'hybrid',
      schema: Type.Object({ request: Type.String(), open: Type.Boolean() }),
      shouldOpenPage: (input: { open: boolean }) => input.open,
      execute: async(_ctx, input: { request: string }) =>
        new Promise<ToolResult>(resolve => resolvers.set(input.request, resolve))
    })
    const actionRouter = createActionRouter(registry, createRouterPort({
      getCurrentRouteName: () => routeName
    }))

    const requestA = actionRouter.execute({
      tool, context, input: { request: 'A', open: true }, requestId: 'request-A'
    })
    const requestB = actionRouter.execute({
      tool, context, input: { request: 'B', open: true }, requestId: 'request-B'
    })
    resolvers.get('A')?.({ ok: true, message: 'A', uiEffect: showQueryEffect })
    resolvers.get('B')?.({ ok: true, message: 'B', uiEffect: showQueryEffect })

    await expect(requestA).resolves.toEqual({
      ok: false,
      message: defaultMessages.pageSyncExpired
    })
    await expect(requestB).resolves.toMatchObject({ ok: true, message: 'B' })
    expect(applyUiEffect).toHaveBeenCalledTimes(1)
    expect(applyUiEffect).toHaveBeenCalledWith(showQueryEffect, 'request-B')
  })

  it('页面兜底 invalidate 后迟到 effect 不应用', async() => {
    const applyUiEffect = vi.fn()
    const registry = new PageAdapterRegistry()
    registry.register(createAdapter(applyUiEffect))
    let resolveTool: ((result: ToolResult) => void) | undefined
    const tool = defineReadTool({
      moduleId: 'gateway', name: 'fallback-query', version: 1,
      title: '查询', description: '查询', aliases: [], risk: 'read', executionMode: 'hybrid',
      schema: Type.Object({ open: Type.Boolean() }),
      shouldOpenPage: (input: { open: boolean }) => input.open,
      execute: () => new Promise<ToolResult>(resolve => { resolveTool = resolve })
    })
    const executing = createActionRouter(registry).execute({
      tool, context, input: { open: true }, requestId
    })

    registry.invalidateRequest('gateway', routeName, requestId)
    resolveTool?.({ ok: true, message: 'late', uiEffect: showQueryEffect })

    await expect(executing).resolves.toEqual({
      ok: false,
      message: defaultMessages.pageSyncExpired
    })
    expect(applyUiEffect).not.toHaveBeenCalled()
  })

  it('同路由无 URL 握手时，latest 请求仍可应用', async() => {
    const applyUiEffect = vi.fn()
    const registry = new PageAdapterRegistry()
    registry.register(createAdapter(applyUiEffect))
    const routerPort = createRouterPort({ getCurrentRouteName: () => routeName })
    const tool = defineReadTool({
      moduleId: 'gateway', name: 'same-route-query', version: 1,
      title: '查询', description: '查询', aliases: [], risk: 'read', executionMode: 'hybrid',
      schema: Type.Object({ open: Type.Boolean() }),
      shouldOpenPage: (input: { open: boolean }) => input.open,
      execute: async() => ({ ok: true, message: 'same', uiEffect: showQueryEffect })
    })

    await expect(createActionRouter(registry, routerPort).execute({
      tool, context, input: { open: true }, requestId
    })).resolves.toMatchObject({ ok: true, message: 'same' })

    expect(routerPort.push).not.toHaveBeenCalled()
    expect(applyUiEffect).toHaveBeenCalledWith(showQueryEffect, requestId)
    expect(registry.isLatestRequest('gateway', routeName, requestId)).toBe(false)
    expect(requestRecordCount(registry)).toBe(0)
  })

  it('Adapter 拒绝同步数据时返回可观察失败', async() => {
    const registry = new PageAdapterRegistry()
    const terminal = vi.fn()
    registry.register(createAdapter(vi.fn((): void => {
      throw new Error('话单页面同步数据无效')
    })))
    const tool = defineReadTool({
      moduleId: 'gateway', name: 'invalid-page-data', version: 1,
      title: '查询', description: '查询', aliases: [], risk: 'read', executionMode: 'hybrid',
      schema: Type.Object({ open: Type.Boolean() }),
      shouldOpenPage: (input: { open: boolean }) => input.open,
      execute: async() => ({ ok: true, message: 'queried', uiEffect: showQueryEffect })
    })

    const executing = createActionRouter(registry).execute({
      tool, context, input: { open: true }, requestId
    })
    registry.observeRequest('gateway', routeName, requestId, terminal)

    await expect(executing).resolves.toEqual({
      ok: false,
      message: defaultMessages.pageSyncFailed
    })
    expect(terminal).toHaveBeenCalledWith('failed')
  })

  it('写操作已 committed 但页面刷新失败时保留已提交语义并禁止误重试', async() => {
    const registry = new PageAdapterRegistry()
    registry.register(createAdapter(vi.fn((): void => {
      throw new Error('线路列表刷新失败')
    })))
    const tool = defineWriteTool({
      moduleId: 'gateway', name: 'committed-page-refresh-failure', version: 1,
      title: '更新', description: '更新', aliases: [], risk: 'write', executionMode: 'global',
      schema: Type.Object({}), prepare: vi.fn(),
      execute: async() => ({
        ok: true,
        message: '更新成功',
        writeState: 'committed' as const,
        uiEffect: { type: 'gateway:refresh' }
      })
    })

    const result = await createActionRouter(registry).execute({
      tool,
      context,
      input: undefined,
      prepared: { title: '确认', rows: [], payload: {}},
      requestId
    })
    expect(result).toEqual({
      ok: false,
      message: defaultMessages.writeCommittedRefreshFailed,
      writeState: 'committed'
    })
    expect(result.message).not.toContain('线路列表刷新失败')
  })

  it('observer 异常不污染已成功应用的页面 effect', async() => {
    const registry = new PageAdapterRegistry()
    registry.register(createAdapter())
    const tool = defineReadTool({
      moduleId: 'gateway', name: 'observer-throws', version: 1,
      title: '查询', description: '查询', aliases: [], risk: 'read', executionMode: 'hybrid',
      schema: Type.Object({ open: Type.Boolean() }),
      shouldOpenPage: (input: { open: boolean }) => input.open,
      execute: async() => ({ ok: true, message: 'queried', uiEffect: showQueryEffect })
    })
    const executing = createActionRouter(registry).execute({
      tool, context, input: { open: true }, requestId
    })
    registry.observeRequest('gateway', routeName, requestId, () => {
      throw new Error('observer failed')
    })

    await expect(executing).resolves.toEqual({
      ok: true,
      message: 'queried',
      uiEffect: showQueryEffect
    })
  })

  it.each([
    [true, 1],
    [false, 0]
  ])('hybrid 先执行 global，shouldOpenPage=%s 时导航次数为 %s', async(shouldOpen, expectedNavigations) => {
    const order: string[] = []
    const applyUiEffect = vi.fn(() => { order.push('apply') })
    const registry = new PageAdapterRegistry()
    const routerPort = createRouterPort({
      push: vi.fn().mockImplementation(async() => {
        order.push('navigate')
        registry.register(createAdapter(applyUiEffect))
      })
    })
    const execute = vi.fn().mockImplementation(async() => {
      order.push('execute')
      return { ok: true, message: 'done', uiEffect: showQueryEffect }
    })
    const tool = defineReadTool({
      moduleId: 'gateway', name: 'query', version: 1, title: '查询', description: '查询', aliases: [],
      risk: 'read', executionMode: 'hybrid', schema: Type.Object({ open: Type.Boolean() }),
      shouldOpenPage: (input: { open: boolean }) => input.open,
      execute
    })

    const result = await createActionRouter(registry, routerPort).execute({
      tool, context, input: { open: shouldOpen }, requestId
    })

    expect(result.ok).toBe(true)
    expect(routerPort.push).toHaveBeenCalledTimes(expectedNavigations)
    expect(order[0]).toBe('execute')
    if (shouldOpen) expect(order).toEqual(['execute', 'navigate', 'apply'])
  })

  it('页面等待超时返回确定性失败结果', async() => {
    const registry = new PageAdapterRegistry()
    const terminal = vi.fn()
    const tool = defineNavigationTool({
      moduleId: 'gateway', name: 'open', version: 1, title: '打开', description: '打开', aliases: [],
      risk: 'navigation', executionMode: 'page', schema: Type.Object({}),
      execute: vi.fn().mockResolvedValue({ ok: true, message: 'opened' })
    })

    await expect(createActionRouter(registry, createRouterPort(), 5).execute({
      tool, context, input: {}, requestId
    })).resolves.toEqual({
      ok: false,
      message: defaultMessages.navigationTimeout
    })
    registry.observeRequest('gateway', routeName, requestId, terminal)
    expect(terminal).toHaveBeenCalledWith('failed')
  })

  it('page 导航等待期间 abort 后超时会 invalidate 请求', async() => {
    const controller = new AbortController()
    const registry = new PageAdapterRegistry()
    const terminal = vi.fn()
    const tool = defineNavigationTool({
      moduleId: 'gateway', name: 'abort-waiting', version: 1,
      title: '打开', description: '打开', aliases: [], risk: 'navigation', executionMode: 'page',
      schema: Type.Object({}), execute: vi.fn()
    })
    const executing = createActionRouter(registry, createRouterPort(), 5).execute({
      tool,
      context: { ...context, signal: controller.signal },
      input: {},
      requestId
    })
    registry.observeRequest('gateway', routeName, requestId, terminal)

    controller.abort()

    await expect(executing).resolves.toEqual({ ok: false, message: defaultMessages.cancelled, cancelled: true })
    expect(registry.isLatestRequest('gateway', routeName, requestId)).toBe(false)
    expect(terminal).toHaveBeenCalledWith('invalidated')
  })

  it('page 工具执行异常保留原错误，不误报页面跳转失败', async() => {
    const registry = new PageAdapterRegistry()
    registry.register(createAdapter())
    const terminal = vi.fn()
    const tool = defineNavigationTool({
      moduleId: 'gateway', name: 'page-throws', version: 1,
      title: '打开', description: '打开', aliases: [], risk: 'navigation', executionMode: 'page',
      schema: Type.Object({}), execute: vi.fn().mockRejectedValue(new Error('工具执行失败'))
    })
    const executing = createActionRouter(registry, createRouterPort({
      getCurrentRouteName: () => routeName
    })).execute({ tool, context, input: {}, requestId })
    registry.observeRequest('gateway', routeName, requestId, terminal)

    await expect(executing).rejects.toThrow('工具执行失败')
    expect(terminal).toHaveBeenCalledWith('failed')
  })

  it('effect 因 abort 拒绝时将页面请求标记为 invalidated', async() => {
    const controller = new AbortController()
    const registry = new PageAdapterRegistry()
    registry.register(createAdapter(vi.fn().mockImplementation(async() => {
      controller.abort()
      throw new Error('effect aborted')
    })))
    const terminal = vi.fn()
    const tool = defineReadTool({
      moduleId: 'gateway', name: 'abort-effect', version: 1,
      title: '查询', description: '查询', aliases: [], risk: 'read', executionMode: 'hybrid',
      schema: Type.Object({ open: Type.Boolean() }),
      shouldOpenPage: (input: { open: boolean }) => input.open,
      execute: async() => ({ ok: true, message: 'queried', uiEffect: showQueryEffect })
    })
    const executing = createActionRouter(registry).execute({
      tool,
      context: { ...context, signal: controller.signal },
      input: { open: true },
      requestId
    })
    registry.observeRequest('gateway', routeName, requestId, terminal)

    await expect(executing).resolves.toEqual({
      ok: false,
      message: defaultMessages.cancelled,
      cancelled: true
    })
    expect(terminal).toHaveBeenCalledWith('invalidated')
  })

  it.each([
    [{ ok: false, message: '查询失败' }, 'failed'],
    [{ ok: true, message: '无页面效果' }, 'failed']
  ])('page 工具结束为 %# 时立即通知页面终态', async(result, expected) => {
    const registry = new PageAdapterRegistry()
    registry.register(createAdapter())
    const terminal = vi.fn()
    const tool = defineNavigationTool({
      moduleId: 'gateway', name: 'page-no-effect', version: 1,
      title: '打开', description: '打开', aliases: [], risk: 'navigation', executionMode: 'page',
      schema: Type.Object({}), execute: vi.fn().mockResolvedValue(result)
    })
    const executing = createActionRouter(registry).execute({ tool, context, input: {}, requestId })
    registry.observeRequest('gateway', routeName, requestId, terminal)

    await executing

    expect(terminal).toHaveBeenCalledWith(expected)
  })

  it('写工具只执行 PreparedAction.payload，绝不重用模型 input', async() => {
    const execute = vi.fn().mockResolvedValue({ ok: true, message: 'created' })
    const tool = defineWriteTool({
      moduleId: 'gateway', name: 'create', version: 1, title: '新增', description: '新增', aliases: [],
      risk: 'write', executionMode: 'global', schema: Type.Object({ gatewayName: Type.String() }),
      prepare: vi.fn(), execute
    })
    const prepared: PreparedAction<{ gatewayName: string; normalized: boolean }> = {
      title: '新增线路', rows: [], payload: { gatewayName: 'normalized-name', normalized: true }
    }

    await createActionRouter(new PageAdapterRegistry()).execute({
      tool,
      context,
      input: { gatewayName: 'raw-model-name' },
      prepared,
      requestId
    })

    expect(execute).toHaveBeenCalledWith(context, prepared.payload)
    expect(execute).not.toHaveBeenCalledWith(context, { gatewayName: 'raw-model-name' })
  })

  it('写工具缺少 prepared 时拒绝执行', async() => {
    const execute = vi.fn()
    const tool = defineWriteTool({
      moduleId: 'gateway', name: 'delete', version: 1, title: '删除', description: '删除', aliases: [],
      risk: 'destructive', executionMode: 'global', schema: Type.Object({ gatewayId: Type.Number() }),
      prepare: vi.fn(), execute
    })

    await expect(createActionRouter(new PageAdapterRegistry()).execute({
      tool, context, input: { gatewayId: 7 }, requestId
    })).resolves.toEqual({ ok: false, message: defaultMessages.writeNotPrepared })
    expect(execute).not.toHaveBeenCalled()
  })
})

function createReadTool(
  executionMode: 'global' | 'hybrid',
  result: ToolResult
): ToolDefinition {
  return defineReadTool({
    moduleId: 'gateway', name: 'query', version: 1, title: '查询', description: '查询', aliases: [],
    risk: 'read', executionMode, schema: Type.Object({}), execute: async() => result
  })
}
