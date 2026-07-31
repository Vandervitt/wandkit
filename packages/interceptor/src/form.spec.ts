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
