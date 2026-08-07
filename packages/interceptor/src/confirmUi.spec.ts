/**
 * 把拦截器的确认请求接到 `@wandkit/ui` 的确认卡片上。
 *
 * 这层刻意很薄，但不能没有——拦截器故意不依赖 UI 包（它要能在没有界面的场景下
 * 单独治理宿主代码），而卡片需要 `confirmationId` 与 `rawRequest`，两者都不在
 * `RequestDisclosure` 里。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createConfirmCardHandler } from './confirmUi'
import type { InterceptedRequest } from './types'

function request(overrides: Partial<InterceptedRequest> = {}): InterceptedRequest {
  return {
    id: 'req-1',
    method: 'DELETE',
    url: 'https://app.test/api/customers/c_1',
    headers: {},
    channel: 'fetch',
    timestamp: 0,
    ...overrides
  }
}

afterEach(() => {
  document.body.replaceChildren()
})

/** 取出挂载点里的卡片，并读它的 `data`。 */
function cardIn(host: HTMLElement) {
  const card = host.firstElementChild as HTMLElement & { data?: unknown }
  return { element: card, data: card?.data as Record<string, unknown> | undefined }
}

describe('入口隔离', () => {
  /**
   * 主入口不得 re-export 本模块。
   *
   * 实施中踩过：一旦从 `index.ts` 导出，任何一次 `import { createInterceptor }`
   * 都会连带拉进 `@wandkit/ui`，而那个包在模块顶层就 `extends HTMLElement`
   * ——在没有 DOM 的环境里直接崩，「拦截器可脱离界面单独使用」这条就废了。
   */
  it('主入口不导出确认卡片接线', async () => {
    const main = await import('./index')

    expect('createConfirmCardHandler' in main).toBe(false)
  })
})

describe('渲染确认卡片', () => {
  it('把披露信息投影成卡片数据', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const confirm = createConfirmCardHandler({ host })

    const pending = confirm({
      request: request(),
      risk: 'destructive',
      disclosure: {
        title: '确认删除客户',
        rows: [{ label: '目标', value: 'c_1' }],
        impact: '删除后不可恢复'
      }
    })
    await Promise.resolve()

    expect(cardIn(host).data).toMatchObject({
      title: '确认删除客户',
      rows: [{ label: '目标', value: 'c_1' }],
      impact: '删除后不可恢复',
      risk: 'destructive'
    })

    cardIn(host).element.dispatchEvent(new CustomEvent('reject', {
      detail: { confirmationId: (cardIn(host).data as { confirmationId: string }).confirmationId }
    }))
    await pending
  })

  it('原始请求原样带上——它是卡片上唯一不可能撒谎的部分', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const confirm = createConfirmCardHandler({ host })

    void confirm({
      request: request({ method: 'DELETE', body: { force: true } }),
      risk: 'destructive'
    })
    await Promise.resolve()

    expect(cardIn(host).data?.rawRequest).toEqual({
      method: 'DELETE',
      url: 'https://app.test/api/customers/c_1',
      body: { force: true }
    })
  })

  it('没有披露信息时退化为原始请求，仍可确认', async () => {
    // describe() 是可选增强，缺了它只是卡片难看些，不该让确认流程走不下去。
    const host = document.createElement('div')
    document.body.appendChild(host)
    const confirm = createConfirmCardHandler({ host })

    void confirm({ request: request({ method: 'POST', url: '/api/v2/purge' }), risk: 'write' })
    await Promise.resolve()

    expect(cardIn(host).data).toMatchObject({
      title: 'POST /api/v2/purge',
      rows: [],
      risk: 'write'
    })
  })

  it('用的是 ui 包的卡片元素，而不是自绘', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const confirm = createConfirmCardHandler({ host })

    void confirm({ request: request(), risk: 'write' })
    await Promise.resolve()

    expect(cardIn(host).element.tagName.toLowerCase()).toBe('wandkit-confirm')
  })
})

describe('用户决定', () => {
  it('批准时 resolve 为 true', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const confirm = createConfirmCardHandler({ host })

    const pending = confirm({ request: request(), risk: 'write' })
    await Promise.resolve()
    const { element, data } = cardIn(host)
    element.dispatchEvent(new CustomEvent('approve', {
      detail: { confirmationId: data?.confirmationId }
    }))

    await expect(pending).resolves.toBe(true)
  })

  it('拒绝时 resolve 为 false', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const confirm = createConfirmCardHandler({ host })

    const pending = confirm({ request: request(), risk: 'write' })
    await Promise.resolve()
    const { element, data } = cardIn(host)
    element.dispatchEvent(new CustomEvent('reject', {
      detail: { confirmationId: data?.confirmationId }
    }))

    await expect(pending).resolves.toBe(false)
  })

  it('决定之后移除卡片，不留残影', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const confirm = createConfirmCardHandler({ host })

    const pending = confirm({ request: request(), risk: 'write' })
    await Promise.resolve()
    const { element, data } = cardIn(host)
    element.dispatchEvent(new CustomEvent('approve', {
      detail: { confirmationId: data?.confirmationId }
    }))
    await pending

    expect(host.children).toHaveLength(0)
  })

  it('过期 ID 的决定被忽略——上一次的卡片不得批准这一次', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const confirm = createConfirmCardHandler({ host })

    const pending = confirm({ request: request(), risk: 'write' })
    await Promise.resolve()
    const { element, data } = cardIn(host)

    element.dispatchEvent(new CustomEvent('approve', {
      detail: { confirmationId: '过期的ID' }
    }))
    // 仍在等待，卡片还在
    expect(host.children).toHaveLength(1)

    element.dispatchEvent(new CustomEvent('approve', {
      detail: { confirmationId: data?.confirmationId }
    }))
    await expect(pending).resolves.toBe(true)
  })
})

describe('并发确认', () => {
  it('AbortSignal 从严拒绝当前和队列中的确认', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const controller = new AbortController()
    const confirm = createConfirmCardHandler({ host, signal: controller.signal })

    const first = confirm({ request: request({ id: 'a' }), risk: 'write' })
    const second = confirm({ request: request({ id: 'b' }), risk: 'write' })
    await Promise.resolve()
    controller.abort()

    const outcome = await Promise.race([
      Promise.all([first, second]),
      new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 50))
    ])

    expect(outcome).toEqual([false, false])
    expect(host.children).toHaveLength(0)
  })

  it('逐个确认，不同时堆两张卡片', async () => {
    // 堆在一起会让人分不清自己批的是哪一个，审计记录也说不清。
    const host = document.createElement('div')
    document.body.appendChild(host)
    const confirm = createConfirmCardHandler({ host })

    const first = confirm({ request: request({ id: 'a' }), risk: 'write' })
    const second = confirm({ request: request({ id: 'b' }), risk: 'write' })
    await Promise.resolve()

    expect(host.children).toHaveLength(1)

    const firstCard = cardIn(host)
    firstCard.element.dispatchEvent(new CustomEvent('approve', {
      detail: { confirmationId: firstCard.data?.confirmationId }
    }))
    await first
    await Promise.resolve()

    // 第一张处理完才轮到第二张
    expect(host.children).toHaveLength(1)
    const secondCard = cardIn(host)
    secondCard.element.dispatchEvent(new CustomEvent('reject', {
      detail: { confirmationId: secondCard.data?.confirmationId }
    }))
    await expect(second).resolves.toBe(false)
  })
})

describe('遮罩联动', () => {
  it('确认期间解除遮罩，让用户点得到卡片', async () => {
    // 遮罩的作用是挡住用户操作页面；但确认卡片本身需要用户点击，不解除就点不到。
    const mask = { arm: vi.fn(), disarm: vi.fn(), armed: true }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const confirm = createConfirmCardHandler({ host, mask })

    const pending = confirm({ request: request(), risk: 'write' })
    await Promise.resolve()
    expect(mask.disarm).toHaveBeenCalledTimes(1)

    const { element, data } = cardIn(host)
    element.dispatchEvent(new CustomEvent('approve', {
      detail: { confirmationId: data?.confirmationId }
    }))
    await pending

    // 决定之后恢复遮罩，Agent 继续动作
    expect(mask.arm).toHaveBeenCalledTimes(1)
  })

  it('确认前遮罩本就未武装时，事后不误开', async () => {
    const mask = { arm: vi.fn(), disarm: vi.fn(), armed: false }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const confirm = createConfirmCardHandler({ host, mask })

    const pending = confirm({ request: request(), risk: 'write' })
    await Promise.resolve()
    const { element, data } = cardIn(host)
    element.dispatchEvent(new CustomEvent('approve', {
      detail: { confirmationId: data?.confirmationId }
    }))
    await pending

    expect(mask.arm).not.toHaveBeenCalled()
  })
})
