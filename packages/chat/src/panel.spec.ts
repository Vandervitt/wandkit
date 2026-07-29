import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CHAT_PANEL_TAG, ToolairlockChatPanel } from './panel'
import type { ChatState } from './protocol'

function mount(state?: Partial<ChatState>): ToolairlockChatPanel {
  const panel = document.createElement(CHAT_PANEL_TAG) as ToolairlockChatPanel
  document.body.appendChild(panel)
  panel.state = { entries: [], status: 'idle', ...state }
  return panel
}

function partOf(panel: ToolairlockChatPanel, name: string): HTMLElement | null {
  return panel.shadowRoot?.querySelector(`[part="${name}"]`) ?? null
}

function partsOf(panel: ToolairlockChatPanel, name: string): HTMLElement[] {
  return Array.from(panel.shadowRoot?.querySelectorAll(`[part="${name}"]`) ?? [])
}

beforeEach(() => {
  document.body.replaceChildren()
})

describe('渲染', () => {
  it('空会话给出明确提示，而不是一片空白', () => {
    const panel = mount()

    expect(partOf(panel, 'empty')?.textContent).toBe('还没有对话')
  })

  it('按角色渲染消息', () => {
    const panel = mount({
      entries: [
        { id: '1', role: 'user', content: '删除张三', at: 1 },
        { id: '2', role: 'assistant', content: '已删除', at: 2 }
      ]
    })

    expect(partsOf(panel, 'entry').map(e => e.getAttribute('data-role')))
      .toEqual(['user', 'assistant'])
    expect(partsOf(panel, 'bubble').map(e => e.textContent))
      .toEqual(['删除张三', '已删除'])
  })

  it('工具结果按成败加符号并标记 data-ok', () => {
    const panel = mount({
      entries: [
        { id: '1', role: 'tool', content: '已删除', ok: true, toolCallId: 'c1', at: 1 },
        { id: '2', role: 'tool', content: '目标不存在', ok: false, toolCallId: 'c2', at: 2 }
      ]
    })

    expect(partsOf(panel, 'bubble').map(e => e.textContent))
      .toEqual(['✓ 已删除', '✕ 目标不存在'])
    expect(partsOf(panel, 'entry').map(e => e.getAttribute('data-ok')))
      .toEqual(['true', 'false'])
  })

  it('工具调用渲染成标签，让人看清 Agent 在做什么', () => {
    const panel = mount({
      entries: [{
        id: '1', role: 'assistant', content: '', at: 1,
        toolCalls: [
          { id: 'c1', type: 'function', function: { name: 'user_query_v1', arguments: '{}' } },
          { id: 'c2', type: 'function', function: { name: 'user_delete_v1', arguments: '{}' } }
        ]
      }]
    })

    expect(partsOf(panel, 'tool-chip').map(e => e.textContent))
      .toEqual(['user_query_v1', 'user_delete_v1'])
  })

  it('流式中显示光标', () => {
    const panel = mount({
      entries: [{ id: '1', role: 'assistant', content: '正在', streaming: true, at: 1 }]
    })

    expect(partOf(panel, 'cursor')).not.toBeNull()
  })

  it('消息内容始终按纯文本渲染', () => {
    // 内容来自模型与业务数据，用富文本渲染就是在治理层自己的界面上开注入口。
    const panel = mount({
      entries: [{ id: '1', role: 'assistant', content: '<img src=x onerror=alert(1)>', at: 1 }]
    })

    expect(partOf(panel, 'bubble')?.querySelector('img')).toBeNull()
    expect(partOf(panel, 'bubble')?.textContent).toBe('<img src=x onerror=alert(1)>')
  })

  it('错误存在时展示，不存在时隐藏', () => {
    const panel = mount({ error: '网络异常' })
    expect(partOf(panel, 'error')?.textContent).toBe('网络异常')

    panel.state = { entries: [], status: 'idle' }
    expect(partOf(panel, 'error')?.style.display).toBe('none')
  })
})

describe('输入', () => {
  it('点击发送派发 send 事件并清空输入框', () => {
    const panel = mount()
    const onSend = vi.fn()
    panel.addEventListener('send', onSend)
    const input = partOf(panel, 'input') as HTMLTextAreaElement
    input.value = '查询用户'

    ;(partOf(panel, 'send') as HTMLButtonElement).click()

    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onSend.mock.calls[0][0].detail).toEqual({ text: '查询用户' })
    expect(input.value).toBe('')
  })

  it('Enter 发送，Shift+Enter 换行', () => {
    const panel = mount()
    const onSend = vi.fn()
    panel.addEventListener('send', onSend)
    const input = partOf(panel, 'input') as HTMLTextAreaElement
    input.value = 'x'

    input.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', shiftKey: true, bubbles: true, cancelable: true
    }))
    expect(onSend).not.toHaveBeenCalled()

    input.value = 'x'
    input.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', bubbles: true, cancelable: true
    }))
    expect(onSend).toHaveBeenCalledTimes(1)
  })

  it('空白输入不派发事件', () => {
    const panel = mount()
    const onSend = vi.fn()
    panel.addEventListener('send', onSend)
    const input = partOf(panel, 'input') as HTMLTextAreaElement
    input.value = '   '

    ;(partOf(panel, 'send') as HTMLButtonElement).click()

    expect(onSend).not.toHaveBeenCalled()
  })

  it('busy 时锁住输入——上一轮还没了结', () => {
    const panel = mount({ status: 'busy' })

    expect((partOf(panel, 'input') as HTMLTextAreaElement).disabled).toBe(true)
    expect((partOf(panel, 'send') as HTMLButtonElement).disabled).toBe(true)
  })

  it('等待确认时同样锁住输入', () => {
    // 此时屏幕上有一张待处理的确认卡片，允许继续发话会让人绕过它。
    const panel = mount({ status: 'awaiting_confirmation' })

    expect((partOf(panel, 'input') as HTMLTextAreaElement).disabled).toBe(true)
  })

  it('锁定期间即使调用 send 也不派发', () => {
    const panel = mount({ status: 'busy' })
    const onSend = vi.fn()
    panel.addEventListener('send', onSend)
    const input = partOf(panel, 'input') as HTMLTextAreaElement
    input.value = '试图插队'

    ;(partOf(panel, 'send') as HTMLButtonElement).click()

    expect(onSend).not.toHaveBeenCalled()
  })

  it('send 事件穿透 Shadow 边界，便于宿主做事件委托', () => {
    const panel = mount()
    const onSend = vi.fn()
    document.body.addEventListener('send', onSend)
    const input = partOf(panel, 'input') as HTMLTextAreaElement
    input.value = 'x'

    ;(partOf(panel, 'send') as HTMLButtonElement).click()

    expect(onSend).toHaveBeenCalled()
  })
})

describe('确认卡片挂载点', () => {
  it('暴露挂载点供宿主放置 toolairlock-confirm', () => {
    // 确认卡片是治理层唯一面向人的界面，由 @toolairlock/ui 的不可裁剪实现负责，
    // 本面板只留位置。
    const panel = mount()

    expect(panel.confirmationHost.getAttribute('part')).toBe('confirmation')
  })

  it('宿主放入的卡片被保留，重绘不会清掉它', () => {
    const panel = mount()
    const card = document.createElement('div')
    card.id = 'card'
    panel.confirmationHost.appendChild(card)

    panel.state = { entries: [{ id: '1', role: 'user', content: 'x', at: 1 }], status: 'busy' }

    expect(panel.shadowRoot?.getElementById('card')).not.toBeNull()
  })
})
