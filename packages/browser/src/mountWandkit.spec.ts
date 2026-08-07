import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LlmMessage } from 'wandkit'
import { startRequestTracking } from '@wandkit/executor'
import { mountWandkit } from './index'

afterEach(() => {
  document.body.replaceChildren()
})

describe('mountWandkit', () => {
  it('一次调用挂载聊天界面并完成消息闭环', async () => {
    const chat = vi.fn(async () => ({
      role: 'assistant' as const,
      content: '已经完成。'
    }))

    const app = mountWandkit({
      llm: { chat },
      heading: 'Admin Copilot',
      getPermissions: () => [],
      interception: { policy: {} }
    })

    const dock = document.querySelector('wandkit-dock')
    const panel = dock?.querySelector('wandkit-chat') as HTMLElement | null
    const heading = panel?.shadowRoot?.querySelector('[part="heading"]')

    expect(dock).not.toBeNull()
    expect(panel).not.toBeNull()
    expect(heading?.textContent).toBe('Admin Copilot')

    await app.controls.send('检查当前页面')

    expect(chat).toHaveBeenCalledTimes(1)
    expect(app.session.state.entries.map(entry => entry.content))
      .toEqual(['检查当前页面', '已经完成。'])
    app.destroy()
  })

  it('保留 assistant tool_calls 与 tool 结果的合法配对', async () => {
    const chat = vi.fn()
      .mockResolvedValueOnce({
        role: 'assistant' as const,
        content: null,
        tool_calls: [{
          id: 'call-1',
          type: 'function' as const,
          function: { name: 'page_read_v1', arguments: '{}' }
        }]
      })
      .mockResolvedValueOnce({
        role: 'assistant' as const,
        content: '页面已经读取。'
      })
    const app = mountWandkit({
      llm: { chat },
      getPermissions: () => [],
      interception: { policy: {} }
    })

    await app.controls.send('读取页面')

    const messages = app.session.toMessages()
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      tool_calls: [{ id: 'call-1' }]
    })
    expect(messages[2]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call-1'
    })
    app.destroy()
  })

  it('保留 Runtime 从兼容 content 规范化出的 tool_calls', async () => {
    const chat = vi.fn()
      .mockResolvedValueOnce({
        role: 'assistant' as const,
        content: '{"name":"page_read_v1","arguments":{}}'
      })
      .mockResolvedValueOnce({
        role: 'assistant' as const,
        content: '页面已经读取。'
      })
    const app = mountWandkit({
      llm: { chat },
      getPermissions: () => [],
      interception: { policy: {} }
    })

    await app.controls.send('读取页面')

    const messages = app.session.toMessages()
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      tool_calls: [{ function: { name: 'page_read_v1' } }]
    })
    expect(messages[2]).toMatchObject({
      role: 'tool',
      tool_call_id: expect.stringMatching(/^compat_/)
    })
    app.destroy()
  })

  it('页面快照排除 Wandkit 自身控件', async () => {
    const button = document.createElement('button')
    button.textContent = '业务按钮'
    document.body.appendChild(button)
    let page = ''
    let round = 0
    const chat = vi.fn(async (messages: LlmMessage[]) => {
      round += 1
      if (round === 1) {
        return {
          role: 'assistant' as const,
          content: null,
          tool_calls: [{
            id: 'read-1',
            type: 'function' as const,
            function: { name: 'page_read_v1', arguments: '{}' }
          }]
        }
      }
      const content = messages.at(-1)?.content
      const result = JSON.parse(typeof content === 'string' ? content : '{}') as { data?: string }
      page = result.data ?? ''
      return { role: 'assistant' as const, content: '读取完成。' }
    })
    const app = mountWandkit({
      llm: { chat },
      getPermissions: () => [],
      interception: { policy: {} }
    })

    await app.controls.send('读取页面')

    expect(page).toContain('业务按钮')
    expect(page).not.toMatch(/打开助手|关闭助手|输入消息|新建对话/)
    app.destroy()
  })

  it('把面板 stop 事件接到 Runtime', () => {
    const app = mountWandkit({
      llm: { chat: vi.fn() },
      getPermissions: () => [],
      interception: { policy: {} }
    })
    const stop = vi.spyOn(app.runtime, 'stop')
    const panel = document.querySelector('wandkit-chat') as HTMLElement
    app.session.setStatus('busy')

    ;(panel.shadowRoot?.querySelector('[part="send"]') as HTMLButtonElement).click()

    expect(stop).toHaveBeenCalledTimes(1)
    app.destroy()
  })

  it('把面板 new-chat 事件接到 Runtime 并清空会话', () => {
    const app = mountWandkit({
      llm: { chat: vi.fn() },
      getPermissions: () => [],
      interception: { policy: {} }
    })
    const clear = vi.spyOn(app.runtime, 'clear')
    const panel = document.querySelector('wandkit-chat') as HTMLElement
    app.session.appendUser('旧消息')
    app.session.append({ role: 'assistant', content: '旧回答' })

    ;(panel.shadowRoot?.querySelector('[part~="new-chat"]') as HTMLButtonElement).click()

    expect(clear).toHaveBeenCalledTimes(1)
    expect(app.session.toMessages()).toEqual([])
    app.destroy()
  })

  it('拦截 Agent 写请求，拒绝后不发送并把工具结果标记为取消', async () => {
    const button = document.createElement('button')
    button.textContent = '提交写请求'
    document.body.appendChild(button)
    const originalFetch = window.fetch
    const nativeFetch = vi.fn(async () => new Response('{}')) as typeof fetch
    window.fetch = nativeFetch
    button.addEventListener('click', () => {
      void window.fetch('/api/write', { method: 'POST' }).catch(() => undefined)
    })

    let round = 0
    const chat = vi.fn(async (messages: LlmMessage[]) => {
      round += 1
      if (round === 1) {
        return {
          role: 'assistant' as const,
          content: null,
          tool_calls: [{
            id: 'read-1',
            type: 'function' as const,
            function: { name: 'page_read_v1', arguments: '{}' }
          }]
        }
      }
      if (round === 2) {
        const content = messages.at(-1)?.content
        const result = JSON.parse(typeof content === 'string' ? content : '{}') as { data?: string }
        const matched = result.data?.match(/\[(\d+)\].*提交写请求/)
        if (!matched) throw new Error('页面快照中没有提交按钮')
        return {
          role: 'assistant' as const,
          content: null,
          tool_calls: [{
            id: 'click-1',
            type: 'function' as const,
            function: {
              name: 'page_click_v1',
              arguments: JSON.stringify({ index: Number(matched[1]) })
            }
          }]
        }
      }
      return { role: 'assistant' as const, content: '已取消提交。' }
    })
    const app = mountWandkit({
      llm: { chat },
      getPermissions: () => [],
      interception: { policy: {} },
      page: { stable: { quietMs: 10, timeoutMs: 1000 } }
    })

    try {
      const running = app.controls.send('提交写请求')
      const panel = document.querySelector('wandkit-chat') as
        HTMLElement & { confirmationHost: HTMLElement }

      await vi.waitFor(() => {
        expect(panel.confirmationHost.querySelector('wandkit-confirm')).not.toBeNull()
      })
      const card = panel.confirmationHost.querySelector('wandkit-confirm') as
        HTMLElement & { data: { confirmationId: string } }
      card.dispatchEvent(new CustomEvent('reject', {
        detail: { confirmationId: card.data.confirmationId }
      }))
      await running

      expect(nativeFetch).not.toHaveBeenCalled()
      const clickResult = app.session.toMessages().find(message =>
        message.role === 'tool' && message.tool_call_id === 'click-1'
      )
      expect(clickResult?.role === 'tool' ? JSON.parse(clickResult.content) : null)
        .toMatchObject({ ok: false, cancelled: true })
      expect(document.querySelector('wandkit-mask')).toBeNull()
    } finally {
      app.destroy()
      window.fetch = originalFetch
    }
  })

  it('在归属宽限期内按精确规则放行 LLM POST，避免二次拦截', async () => {
    const button = document.createElement('button')
    button.textContent = '触发页面动作'
    document.body.appendChild(button)
    const originalFetch = window.fetch
    const nativeFetch = vi.fn(async () => new Response('{}')) as typeof fetch
    window.fetch = nativeFetch
    button.addEventListener('click', () => {
      void window.fetch('/api/read').catch(() => undefined)
    })

    let round = 0
    const chat = vi.fn(async (messages: LlmMessage[]) => {
      await window.fetch('/llm/chat', { method: 'POST' })
      round += 1
      if (round === 1) {
        return {
          role: 'assistant' as const,
          content: null,
          tool_calls: [{
            id: 'read-1',
            type: 'function' as const,
            function: { name: 'page_read_v1', arguments: '{}' }
          }]
        }
      }
      if (round === 2) {
        const content = messages.at(-1)?.content
        const result = JSON.parse(typeof content === 'string' ? content : '{}') as { data?: string }
        const matched = result.data?.match(/\[(\d+)\].*触发页面动作/)
        if (!matched) throw new Error('页面快照中没有动作按钮')
        return {
          role: 'assistant' as const,
          content: null,
          tool_calls: [{
            id: 'click-1',
            type: 'function' as const,
            function: {
              name: 'page_click_v1',
              arguments: JSON.stringify({ index: Number(matched[1]) })
            }
          }]
        }
      }
      return { role: 'assistant' as const, content: '动作完成。' }
    })
    const app = mountWandkit({
      llm: { chat },
      getPermissions: () => [],
      interception: {
        policy: { defaultForUnsafeMethods: 'deny' },
        llmRequest: { method: 'POST', url: '/llm/chat' }
      },
      page: { stable: { quietMs: 10, timeoutMs: 1000 } }
    })

    try {
      await app.controls.send('执行页面动作')

      expect(app.session.state.entries.at(-1)?.content).toBe('动作完成。')
      expect(nativeFetch).toHaveBeenCalledTimes(4)
      expect(document.querySelector('wandkit-confirm')).toBeNull()
    } finally {
      app.destroy()
      window.fetch = originalFetch
    }
  })

  it('LLM 请求悬挂期间不误放行延迟到达的业务写请求', async () => {
    const button = document.createElement('button')
    button.textContent = '触发页面动作'
    document.body.appendChild(button)
    const originalFetch = window.fetch
    const nativeFetch = vi.fn(async () => new Response('{}')) as typeof fetch
    window.fetch = nativeFetch
    button.addEventListener('click', () => {
      void window.fetch('/api/read').catch(() => undefined)
    })
    let markLlmEntered: () => void = () => undefined
    const llmEntered = new Promise<void>(resolve => { markLlmEntered = resolve })
    let releaseLlm: () => void = () => undefined
    const llmPending = new Promise<void>(resolve => { releaseLlm = resolve })
    let round = 0
    const chat = vi.fn(async (messages: LlmMessage[]) => {
      await window.fetch('/llm/chat', { method: 'POST' })
      round += 1
      if (round === 1) {
        return {
          role: 'assistant' as const,
          content: null,
          tool_calls: [{
            id: 'read-1',
            type: 'function' as const,
            function: { name: 'page_read_v1', arguments: '{}' }
          }]
        }
      }
      if (round === 2) {
        const content = messages.at(-1)?.content
        const result = JSON.parse(typeof content === 'string' ? content : '{}') as { data?: string }
        const matched = result.data?.match(/\[(\d+)\].*触发页面动作/)
        if (!matched) throw new Error('页面快照中没有动作按钮')
        return {
          role: 'assistant' as const,
          content: null,
          tool_calls: [{
            id: 'click-1',
            type: 'function' as const,
            function: {
              name: 'page_click_v1',
              arguments: JSON.stringify({ index: Number(matched[1]) })
            }
          }]
        }
      }
      markLlmEntered()
      await llmPending
      return { role: 'assistant' as const, content: '完成。' }
    })
    const app = mountWandkit({
      llm: { chat },
      getPermissions: () => [],
      interception: {
        policy: { defaultForUnsafeMethods: 'deny' },
        llmRequest: { method: 'POST', url: '/llm/chat' }
      },
      page: { stable: { quietMs: 10, timeoutMs: 1000 } }
    })
    const running = app.controls.send('执行页面动作')

    try {
      await llmEntered

      await expect(window.fetch('/api/business-write', { method: 'POST' }))
        .rejects.toThrow('Request was not approved.')
      expect(nativeFetch).toHaveBeenCalledTimes(4)
    } finally {
      releaseLlm()
      await running
      app.destroy()
      window.fetch = originalFetch
    }
  })

  it('destroy 幂等还原全局 API 并移除 UI', () => {
    const originalFetch = window.fetch
    const originalSend = XMLHttpRequest.prototype.send
    const originalPushState = history.pushState
    const app = mountWandkit({
      llm: { chat: vi.fn() },
      getPermissions: () => [],
      interception: { policy: {} }
    })

    expect(window.fetch).not.toBe(originalFetch)
    expect(XMLHttpRequest.prototype.send).not.toBe(originalSend)
    expect(history.pushState).not.toBe(originalPushState)

    app.destroy()
    app.destroy()

    expect(window.fetch).toBe(originalFetch)
    expect(XMLHttpRequest.prototype.send).toBe(originalSend)
    expect(history.pushState).toBe(originalPushState)
    expect(document.querySelector('wandkit-dock')).toBeNull()
    expect(document.querySelector('wandkit-mask')).toBeNull()
  })

  it('宿主已持有 tracker 时拒绝以错误顺序挂载并回滚本次资源', () => {
    const originalFetch = window.fetch
    const originalPushState = history.pushState
    const releaseHostTracking = startRequestTracking()
    const hostTrackedFetch = window.fetch

    try {
      expect(() => mountWandkit({
        llm: { chat: vi.fn() },
        getPermissions: () => [],
        interception: { policy: {} }
      })).toThrow('request tracker 必须位于其他请求 patch 的最外层')

      expect(window.fetch).toBe(hostTrackedFetch)
      expect(history.pushState).toBe(originalPushState)
      expect(document.querySelector('wandkit-dock')).toBeNull()
    } finally {
      releaseHostTracking()
    }
    expect(window.fetch).toBe(originalFetch)
  })

  it('interceptor 安装失败时还原 PageController 的 history patch', () => {
    const originalFetch = window.fetch
    const originalPushState = history.pushState
    const sendDescriptor = Object.getOwnPropertyDescriptor(
      XMLHttpRequest.prototype,
      'send'
    ) as PropertyDescriptor
    Object.defineProperty(XMLHttpRequest.prototype, 'send', {
      ...sendDescriptor,
      writable: false
    })

    try {
      expect(() => mountWandkit({
        llm: { chat: vi.fn() },
        getPermissions: () => [],
        interception: { policy: {} }
      })).toThrow()

      expect(window.fetch).toBe(originalFetch)
      expect(history.pushState).toBe(originalPushState)
      expect(document.querySelector('wandkit-dock')).toBeNull()
    } finally {
      Object.defineProperty(XMLHttpRequest.prototype, 'send', sendDescriptor)
    }
  })

  it('确认卡悬挂时 destroy 会结束等待而不是拖到稳定超时', async () => {
    const button = document.createElement('button')
    button.textContent = '等待确认后销毁'
    document.body.appendChild(button)
    const originalFetch = window.fetch
    const nativeFetch = vi.fn(async () => new Response('{}')) as typeof fetch
    window.fetch = nativeFetch
    button.addEventListener('click', () => {
      void window.fetch('/api/write', { method: 'POST' }).catch(() => undefined)
    })

    let round = 0
    const chat = vi.fn(async (messages: LlmMessage[]) => {
      round += 1
      if (round === 1) {
        return {
          role: 'assistant' as const,
          content: null,
          tool_calls: [{
            id: 'read-1',
            type: 'function' as const,
            function: { name: 'page_read_v1', arguments: '{}' }
          }]
        }
      }
      const content = messages.at(-1)?.content
      const result = JSON.parse(typeof content === 'string' ? content : '{}') as { data?: string }
      const matched = result.data?.match(/\[(\d+)\].*等待确认后销毁/)
      if (!matched) return { role: 'assistant' as const, content: '结束。' }
      return {
        role: 'assistant' as const,
        content: null,
        tool_calls: [{
          id: 'click-1',
          type: 'function' as const,
          function: {
            name: 'page_click_v1',
            arguments: JSON.stringify({ index: Number(matched[1]) })
          }
        }]
      }
    })
    const app = mountWandkit({
      llm: { chat },
      getPermissions: () => [],
      interception: { policy: {} },
      page: { stable: { quietMs: 10, timeoutMs: 500 } }
    })
    const running = app.controls.send('触发写请求')
    const panel = document.querySelector('wandkit-chat') as
      HTMLElement & { confirmationHost: HTMLElement }

    try {
      await vi.waitFor(() => {
        expect(panel.confirmationHost.querySelector('wandkit-confirm')).not.toBeNull()
      })
      const card = panel.confirmationHost.querySelector('wandkit-confirm') as
        HTMLElement & { data: { confirmationId: string } }

      app.destroy()
      // 销毁后即使旧卡片引用被外部代码误触，也不得再把已挂起的请求放出去。
      card.dispatchEvent(new CustomEvent('approve', {
        detail: { confirmationId: card.data.confirmationId }
      }))
      const outcome = await Promise.race([
        running.then(() => 'settled'),
        new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 100))
      ])

      expect(outcome).toBe('settled')
      expect(nativeFetch).not.toHaveBeenCalled()
    } finally {
      await running
      app.destroy()
      window.fetch = originalFetch
    }
  })
})
