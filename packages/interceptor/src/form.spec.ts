import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStaticAttribution } from './attribution'
import { createInterceptor } from './interceptor'
import type {
  ConfirmRequestHandler,
  Interceptor,
  InterceptorOptions
} from './interceptor'

const originalSubmit = HTMLFormElement.prototype.submit
let interceptor: Interceptor | undefined
let uninstall: (() => void) | undefined
let submitted: HTMLFormElement[]

function setup(overrides: Partial<InterceptorOptions> = {}) {
  const confirm = vi.fn<Parameters<ConfirmRequestHandler>, Promise<boolean>>(
    async () => true
  )
  interceptor = createInterceptor({
    policy: { defaultForSafeMethods: 'confirm' },
    attribution: createStaticAttribution(true),
    confirm,
    channels: ['form'],
    ...overrides
  })
  uninstall = interceptor.install()
  return { confirm }
}

function createForm(markup = '<input name="name" value="张三">'): HTMLFormElement {
  const form = document.createElement('form')
  form.action = '/api/users'
  form.method = 'post'
  form.innerHTML = markup
  document.body.append(form)
  return form
}

function dispatchSubmit(
  form: HTMLFormElement,
  submitter: HTMLElement | null = null
): SubmitEvent {
  const event = new SubmitEvent('submit', {
    bubbles: true,
    cancelable: true,
    submitter
  })
  form.dispatchEvent(event)
  return event
}

async function flushFormGate(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (condition()) return
    await Promise.resolve()
  }
  throw new Error('Condition was not reached within 10 microtasks.')
}

beforeEach(() => {
  submitted = []
  document.body.replaceChildren()
  HTMLFormElement.prototype.submit = function stubSubmit(this: HTMLFormElement) {
    submitted.push(this)
  }
})

afterEach(() => {
  uninstall?.()
  uninstall = undefined
  interceptor = undefined
  HTMLFormElement.prototype.submit = originalSubmit
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('原生 submit 事件', () => {
  it('显式 form 通道暂停原生提交，批准后只重放一次', async () => {
    const { confirm } = setup()
    const form = createForm()
    const hostSubmit = vi.fn()
    form.addEventListener('submit', hostSubmit)

    const event = dispatchSubmit(form)
    await flushFormGate()

    expect(event.defaultPrevented).toBe(true)
    expect(hostSubmit).toHaveBeenCalledTimes(1)
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm.mock.calls[0][0].request).toMatchObject({
      method: 'POST',
      channel: 'form'
    })
    expect(submitted).toEqual([form])
  })

  it('requestSubmit 使用 submitter 的有效提交配置', async () => {
    const { confirm } = setup()
    const form = createForm(`
      <input name="name" value="张三">
      <button name="intent" value="preview"
        formaction="/api/preview" formmethod="get">预览</button>
    `)
    const button = form.querySelector('button') as HTMLButtonElement

    form.requestSubmit(button)
    await flushFormGate()

    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm.mock.calls[0][0].request).toMatchObject({
      method: 'GET',
      url: `${location.origin}/api/preview?name=%E5%BC%A0%E4%B8%89&intent=preview`,
      body: undefined
    })
    expect(submitted).toEqual([form])
  })
})

describe('直接 form.submit()', () => {
  it('同步返回 undefined，批准前不调用原实现，批准后延迟调用', async () => {
    let approve!: (allowed: boolean) => void
    setup({
      confirm: vi.fn(() => new Promise<boolean>(resolve => { approve = resolve }))
    })
    const form = createForm()

    const result = form.submit()

    expect(result).toBeUndefined()
    expect(submitted).toHaveLength(0)
    await Promise.resolve()
    approve(true)
    await flushFormGate()
    expect(submitted).toEqual([form])
  })
})

describe('表单请求投影', () => {
  it('POST 重复字段按出现顺序保留为数组', async () => {
    const { confirm } = setup()
    const form = createForm(`
      <input name="tag" value="a">
      <input name="tag" value="b">
    `)

    dispatchSubmit(form)
    await flushFormGate()

    expect(confirm.mock.calls[0][0].request.body).toEqual({ tag: ['a', 'b'] })
  })

  it('POST 使用 submitter 的 formenctype', async () => {
    const { confirm } = setup()
    const form = createForm(`
      <input name="name" value="张三">
      <button formenctype="text/plain">保存</button>
    `)
    const button = form.querySelector('button') as HTMLButtonElement

    dispatchSubmit(form, button)
    await flushFormGate()

    expect(confirm.mock.calls[0][0].request.headers).toEqual({
      'content-type': 'text/plain'
    })
  })

  it('文件只投影元数据，FormData 动态字段参与请求', async () => {
    const { confirm } = setup()
    const form = createForm('<input type="file" name="attachment">')
    const NativeFormData = window.FormData
    const file = new File(['abc'], 'proof.txt', {
      type: 'text/plain',
      lastModified: 123
    })
    vi.spyOn(window, 'FormData').mockImplementation(
      function formDataWithDynamicField(
        formArg?: HTMLFormElement,
        submitter?: HTMLElement | null
      ) {
        const data = formArg
          ? new NativeFormData(formArg, submitter ?? undefined)
          : new NativeFormData()
        data.set('attachment', file)
        data.set('token', 'stable')
        return data
      } as unknown as (
        form?: HTMLFormElement,
        submitter?: HTMLElement | null
      ) => FormData
    )

    dispatchSubmit(form)
    await flushFormGate()

    expect(confirm.mock.calls[0][0].request.body).toEqual({
      attachment: {
        kind: 'file',
        name: 'proof.txt',
        type: 'text/plain',
        size: 3,
        lastModified: 123
      },
      token: 'stable'
    })
  })
})

describe('批准快照失效', () => {
  it('等待确认期间字段值变化会丢弃旧提交', async () => {
    let approve!: (allowed: boolean) => void
    setup({
      confirm: vi.fn(() => new Promise<boolean>(resolve => { approve = resolve }))
    })
    const form = createForm()

    dispatchSubmit(form)
    await waitFor(() => typeof approve === 'function')
    ;(form.elements.namedItem('name') as HTMLInputElement).value = '李四'
    approve(true)
    await flushFormGate()

    expect(submitted).toHaveLength(0)
  })

  it('等待确认期间 target 变化会丢弃旧提交', async () => {
    let approve!: (allowed: boolean) => void
    setup({
      confirm: vi.fn(() => new Promise<boolean>(resolve => { approve = resolve }))
    })
    const form = createForm()

    dispatchSubmit(form)
    await waitFor(() => typeof approve === 'function')
    form.target = 'other-frame'
    approve(true)
    await flushFormGate()

    expect(submitted).toHaveLength(0)
  })

  it('等待确认期间 acceptCharset 变化会丢弃旧提交', async () => {
    let approve!: (allowed: boolean) => void
    setup({
      confirm: vi.fn(() => new Promise<boolean>(resolve => { approve = resolve }))
    })
    const form = createForm()

    dispatchSubmit(form)
    await waitFor(() => typeof approve === 'function')
    form.acceptCharset = 'iso-8859-1'
    approve(true)
    await flushFormGate()

    expect(submitted).toHaveLength(0)
  })
})

describe('非网络表单边界', () => {
  it('method=dialog 的 submit 事件不进入网络闸门', async () => {
    const { confirm } = setup()
    const form = createForm()
    form.setAttribute('method', 'dialog')

    const event = dispatchSubmit(form)
    await flushFormGate()

    expect(event.defaultPrevented).toBe(false)
    expect(confirm).not.toHaveBeenCalled()
    expect(submitted).toHaveLength(0)
  })

  it('method=dialog 的直接 submit 同步透传原实现', () => {
    const { confirm } = setup()
    const form = createForm()
    form.setAttribute('method', 'dialog')

    const result = form.submit()

    expect(result).toBeUndefined()
    expect(confirm).not.toHaveBeenCalled()
    expect(submitted).toEqual([form])
  })
})

describe('多实例表单治理', () => {
  it('同一 submit 事件按 B → A → browser 执行', async () => {
    const order: string[] = []
    const instanceA = createInterceptor({
      policy: {},
      attribution: createStaticAttribution(true),
      confirm: vi.fn(async () => { order.push('A'); return true }),
      channels: ['form']
    })
    const instanceB = createInterceptor({
      policy: {},
      attribution: createStaticAttribution(true),
      confirm: vi.fn(async () => { order.push('B'); return true }),
      channels: ['form']
    })
    const uninstallA = instanceA.install()
    const uninstallB = instanceB.install()
    const form = createForm()

    try {
      dispatchSubmit(form)
      await flushFormGate()

      expect(order).toEqual(['B', 'A'])
      expect(submitted).toEqual([form])
    } finally {
      uninstallB()
      uninstallA()
    }
  })
})

describe('批准后的安全重放', () => {
  it('重放保留 submitter 配置和字段，并在调用后恢复表单', async () => {
    const replayed: Array<{
      action: string
      method: string
      enctype: string
      target: string
      data: Record<string, string>
    }> = []
    const NativeFormData = window.FormData
    HTMLFormElement.prototype.submit = function captureSubmit(this: HTMLFormElement) {
      const data: Record<string, string> = {}
      new NativeFormData(this).forEach((value, name) => {
        data[name] = typeof value === 'string' ? value : value.name
      })
      replayed.push({
        action: this.action,
        method: this.method,
        enctype: this.enctype,
        target: this.target,
        data
      })
      submitted.push(this)
    }
    const { confirm } = setup()
    const form = createForm(`
      <input name="name" value="张三">
      <button name="intent" value="preview"
        formaction="/api/preview" formmethod="get"
        formenctype="text/plain" formtarget="preview-frame">预览</button>
    `)
    const button = form.querySelector('button') as HTMLButtonElement
    const originalAttributes = {
      action: form.getAttribute('action'),
      method: form.getAttribute('method'),
      enctype: form.getAttribute('enctype'),
      target: form.getAttribute('target')
    }

    dispatchSubmit(form, button)
    await flushFormGate()

    expect(confirm).toHaveBeenCalledTimes(1)
    expect(replayed).toEqual([{
      action: `${location.origin}/api/preview`,
      method: 'get',
      enctype: 'text/plain',
      target: 'preview-frame',
      data: { name: '张三', intent: 'preview' }
    }])
    expect({
      action: form.getAttribute('action'),
      method: form.getAttribute('method'),
      enctype: form.getAttribute('enctype'),
      target: form.getAttribute('target')
    }).toEqual(originalAttributes)
    expect(form.querySelectorAll('[data-toolairlock-replay]')).toHaveLength(0)
  })
})

describe('事务式安装', () => {
  it('form 监听安装失败会回滚此前安装的所有通道', () => {
    const previousFetch = window.fetch
    const previousBeacon = navigator.sendBeacon
    const baselineFetch = vi.fn(async () => new Response('{}')) as typeof fetch
    const baselineOpen = XMLHttpRequest.prototype.open
    const baselineSend = XMLHttpRequest.prototype.send
    const baselineBeacon = vi.fn(() => true) as typeof navigator.sendBeacon
    const baselineSubmit = HTMLFormElement.prototype.submit
    window.fetch = baselineFetch
    navigator.sendBeacon = baselineBeacon
    const instance = createInterceptor({
      policy: {},
      attribution: createStaticAttribution(true),
      confirm: vi.fn(async () => true),
      channels: ['fetch', 'xhr', 'beacon', 'form']
    })
    const addEventListener = window.addEventListener.bind(window)
    vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
      if (type === 'submit') throw new Error('submit listener denied')
      addEventListener(type, listener, options)
    })

    try {
      expect(() => instance.install()).toThrow('submit listener denied')
      expect(instance.installed).toBe(false)
      expect(window.fetch).toBe(baselineFetch)
      expect(XMLHttpRequest.prototype.open).toBe(baselineOpen)
      expect(XMLHttpRequest.prototype.send).toBe(baselineSend)
      expect(navigator.sendBeacon).toBe(baselineBeacon)
      expect(HTMLFormElement.prototype.submit).toBe(baselineSubmit)
    } finally {
      window.fetch = previousFetch
      XMLHttpRequest.prototype.open = baselineOpen
      XMLHttpRequest.prototype.send = baselineSend
      navigator.sendBeacon = previousBeacon
      HTMLFormElement.prototype.submit = baselineSubmit
    }
  })

  it('不兼容的共享注册表会拒绝安装且不覆盖外部值', () => {
    const registrySymbol = Symbol.for('@toolairlock/interceptor.form-registry')
    const registryHost = window as unknown as Record<PropertyKey, unknown>
    const previousDescriptor = Object.getOwnPropertyDescriptor(window, registrySymbol)
    const externalRegistry = { owner: 'host' }
    const previousFetch = window.fetch
    const baselineFetch = vi.fn(async () => new Response('{}')) as typeof fetch
    window.fetch = baselineFetch
    Object.defineProperty(window, registrySymbol, {
      configurable: true,
      value: externalRegistry
    })
    const instance = createInterceptor({
      policy: {},
      attribution: createStaticAttribution(true),
      confirm: vi.fn(async () => true),
      channels: ['fetch', 'form']
    })
    let unexpectedUninstall: (() => void) | undefined

    try {
      expect(() => { unexpectedUninstall = instance.install() })
        .toThrow('Incompatible form interceptor registry')
      expect(instance.installed).toBe(false)
      expect(window.fetch).toBe(baselineFetch)
      expect(registryHost[registrySymbol]).toBe(externalRegistry)
    } finally {
      unexpectedUninstall?.()
      window.fetch = previousFetch
      if (previousDescriptor) {
        Object.defineProperty(window, registrySymbol, previousDescriptor)
      } else {
        delete registryHost[registrySymbol]
      }
    }
  })
})
