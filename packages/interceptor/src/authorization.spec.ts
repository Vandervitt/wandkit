import { describe, expect, it, vi } from 'vitest'
import { createAuthorizationScope, runAuthorized } from './authorization'

describe('已授权窗口', () => {
  it('未开窗时不授权', () => {
    expect(createAuthorizationScope().isAuthorized()).toBe(false)
  })

  it('开窗期间授权，关窗后恢复', () => {
    const scope = createAuthorizationScope()

    scope.begin('run-1:c1')
    expect(scope.isAuthorized()).toBe(true)

    scope.end('run-1:c1')
    expect(scope.isAuthorized()).toBe(false)
  })

  it('嵌套开窗用计数而非布尔——内层关闭不得提前撤销外层授权', () => {
    // 一个工具的 execute 内部可能再触发嵌套的已授权操作。用布尔量的话，内层的
    // end 会把外层的窗口一起关掉，外层剩余请求于是重新开始弹卡片。
    const scope = createAuthorizationScope()

    scope.begin('outer')
    scope.begin('inner')
    scope.end('inner')

    expect(scope.isAuthorized()).toBe(true)

    scope.end('outer')
    expect(scope.isAuthorized()).toBe(false)
  })

  it('重复 end 同一个 token 不会把计数压到负数', () => {
    // 压成负数的话，下一次 begin 之后 isAuthorized 仍是 false，闸门会在本该放行的
    // 时候拦人。
    const scope = createAuthorizationScope()

    scope.begin('a')
    scope.end('a')
    scope.end('a')
    scope.begin('b')

    expect(scope.isAuthorized()).toBe(true)
  })

  it('end 一个从未 begin 的 token 是安全的', () => {
    const scope = createAuthorizationScope()

    expect(() => scope.end('从未开过')).not.toThrow()
    expect(scope.isAuthorized()).toBe(false)
  })
})

describe('runAuthorized', () => {
  it('执行期间开窗，返回后关窗', async () => {
    const scope = createAuthorizationScope()
    let insideWindow = false

    await runAuthorized({ scope, token: 'c1' }, async () => {
      insideWindow = scope.isAuthorized()
    })

    expect(insideWindow).toBe(true)
    expect(scope.isAuthorized()).toBe(false)
  })

  it('抛异常时同样关窗——否则闸门就此静默失效', async () => {
    // execute 抛错却没关窗口，后续所有 Agent 请求都会被无条件放行。
    const scope = createAuthorizationScope()

    await expect(
      runAuthorized({ scope, token: 'c1' }, async () => { throw new Error('写入失败') })
    ).rejects.toThrow('写入失败')

    expect(scope.isAuthorized()).toBe(false)
  })

  it('原样返回被包裹函数的结果', async () => {
    const scope = createAuthorizationScope()

    const result = await runAuthorized({ scope, token: 'c1' }, async () => ({ ok: true }))

    expect(result).toEqual({ ok: true })
  })

  it('并发的两次授权执行互不干扰', async () => {
    // 两个写工具并行执行时，先返回的那个不该把另一个的窗口关掉。
    const scope = createAuthorizationScope()
    let release: () => void = () => undefined
    const blocked = new Promise<void>(resolve => { release = resolve })
    const seen: boolean[] = []

    const slow = runAuthorized({ scope, token: 'slow' }, async () => {
      await blocked
      seen.push(scope.isAuthorized())
    })
    const fast = runAuthorized({ scope, token: 'fast' }, async () => undefined)

    await fast
    // fast 已结束，但 slow 的窗口还开着
    expect(scope.isAuthorized()).toBe(true)

    release()
    await slow
    expect(seen).toEqual([true])
    expect(scope.isAuthorized()).toBe(false)
  })
})

describe('与拦截器协作', () => {
  it('窗口内的请求被判为已授权，无需再问人', async () => {
    const { createInterceptor } = await import('./interceptor')
    const { createStaticAttribution } = await import('./attribution')
    const scope = createAuthorizationScope()
    const confirm = vi.fn(async () => true)
    const originalFetch = window.fetch
    const sent: string[] = []
    window.fetch = vi.fn(async (input: RequestInfo | URL) => {
      sent.push(String(input))
      return new Response('{}')
    }) as typeof fetch

    const interceptor = createInterceptor({
      policy: {},
      attribution: createStaticAttribution(true),
      authorization: scope,
      confirm
    })
    const uninstall = interceptor.install()

    await runAuthorized({ scope, token: 'c1' }, async () => {
      await fetch('/api/users/u_1', { method: 'DELETE' })
    })

    uninstall()
    window.fetch = originalFetch

    expect(confirm).not.toHaveBeenCalled()
    expect(sent).toEqual(['/api/users/u_1'])
  })

  it('窗口外的同一个请求仍要确认', async () => {
    const { createInterceptor } = await import('./interceptor')
    const { createStaticAttribution } = await import('./attribution')
    const scope = createAuthorizationScope()
    const confirm = vi.fn(async () => true)
    const originalFetch = window.fetch
    window.fetch = vi.fn(async () => new Response('{}')) as typeof fetch

    const interceptor = createInterceptor({
      policy: {},
      attribution: createStaticAttribution(true),
      authorization: scope,
      confirm
    })
    const uninstall = interceptor.install()

    await fetch('/api/users/u_1', { method: 'DELETE' })

    uninstall()
    window.fetch = originalFetch

    expect(confirm).toHaveBeenCalledTimes(1)
  })
})
