import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CHAT_PANEL_TAG, ToolairlockChatPanel } from './panel'
import type { ChatState } from './protocol'

function mount(state?: Partial<ChatState>): ToolairlockChatPanel {
  const panel = document.createElement(CHAT_PANEL_TAG) as ToolairlockChatPanel
  document.body.appendChild(panel)
  panel.state = { entries: [], status: 'idle', ...state }
  return panel
}

// 按 token 匹配：`part` 是空格分隔的列表（如 `action close`），整串相等会漏掉多 token 的节点。
function partOf(panel: ToolairlockChatPanel, name: string): HTMLElement | null {
  return panel.shadowRoot?.querySelector(`[part~="${name}"]`) ?? null
}

function partsOf(panel: ToolairlockChatPanel, name: string): HTMLElement[] {
  return Array.from(panel.shadowRoot?.querySelectorAll(`[part~="${name}"]`) ?? [])
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

  it('消息带时分时间戳', () => {
    const panel = mount({
      entries: [
        { id: '1', role: 'user', content: '删除张三', at: Date.parse('2026-07-30T09:05:00') }
      ]
    })

    const stamps = partsOf(panel, 'time')
    expect(stamps).toHaveLength(1)
    expect(stamps[0].textContent).toBe('09:05')
  })

  /**
   * 执行过程不进聊天。
   *
   * 曾经把每一次工具调用与工具结果都渲染出来，用户看到的是 `page_click_v1`、
   * `✓ 已点击 [0]` 这类东西——内部函数名加元素下标，还把唯一一句真正的回答淹没在
   * 十几条噪声里。现在只留一行业务语言的进度，Run 一结束就消失。
   */
  describe('执行进度', () => {
    it('忙碌时在末尾渲染一行进度，用业务语言而非函数名', () => {
      const panel = mount({
        entries: [{ id: '1', role: 'user', content: '新建员工', at: 1 }],
        status: 'busy',
        progress: '已打开「员工管理」'
      })

      expect(partOf(panel, 'step-label')?.textContent).toBe('已打开「员工管理」')
      expect(panel.shadowRoot?.textContent).not.toContain('page_click_v1')
    })

    it('还没有任何步骤完成时给一句泛化文案', () => {
      // 这段时间恰恰是用户最容易以为「它没反应」的时候，不能一片空白。
      const panel = mount({
        entries: [{ id: '1', role: 'user', content: '新建员工', at: 1 }],
        status: 'busy'
      })

      expect(partOf(panel, 'step-label')?.textContent).toBe('正在处理…')
    })

    it('Run 结束后进度行消失，只留最终回答', () => {
      const panel = mount({
        entries: [
          { id: '1', role: 'user', content: '新建员工', at: 1 },
          { id: '2', role: 'assistant', content: '已创建员工「新员工」。', at: 2 }
        ],
        status: 'idle'
      })

      expect(partOf(panel, 'step')).toBeNull()
      expect(partsOf(panel, 'bubble').map(e => e.textContent))
        .toEqual(['新建员工', '已创建员工「新员工」。'])
    })

    it('刚发出第一句、还没有任何条目时也显示进度而不是空态', () => {
      const panel = mount({ entries: [], status: 'busy' })

      expect(partOf(panel, 'step')).not.toBeNull()
      expect(partOf(panel, 'empty')).toBeNull()
    })
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

describe('状态可见性', () => {
  it('标题栏如实反映会话状态', () => {
    const panel = mount({ status: 'busy' })
    expect(partOf(panel, 'status')?.getAttribute('data-status')).toBe('busy')
    expect(partOf(panel, 'status')?.textContent).toContain('执行中')

    panel.state = { entries: [], status: 'awaiting_confirmation' }
    expect(partOf(panel, 'status')?.getAttribute('data-status'))
      .toBe('awaiting_confirmation')
    expect(partOf(panel, 'status')?.textContent).toContain('等待确认')
  })

  it('进度条只在真正执行时激活', () => {
    // 等待确认时球在用户脚下，进度条继续扫会造成「系统还在忙」的错觉，
    // 人就不去点卡片了。
    const panel = mount({ status: 'busy' })
    expect(partOf(panel, 'progress')?.getAttribute('data-active')).toBe('true')

    panel.state = { entries: [], status: 'awaiting_confirmation' }
    expect(partOf(panel, 'progress')?.getAttribute('data-active')).toBe('false')
  })

  it('锁住输入时占位文案说明原因并指路', () => {
    // 锁住却不说原因，用户只会觉得界面坏了——尤其该做的事在屏幕别处。
    const panel = mount({ status: 'awaiting_confirmation' })
    const input = partOf(panel, 'input') as HTMLTextAreaElement

    expect(input.placeholder).toBe('请先处理上方的确认卡片')

    panel.state = { entries: [], status: 'idle' }
    expect(input.placeholder).toBe('说点什么…')
  })

  it('标题由宿主决定，本包不塞自己的品牌', () => {
    const panel = mount()
    expect(partOf(panel, 'heading')?.textContent).toBe('助手')

    panel.heading = '客户助手'
    expect(partOf(panel, 'heading')?.textContent).toBe('客户助手')
  })
})

describe('滚动', () => {
  /** jsdom 没有布局，scrollHeight / clientHeight 恒为 0，只能手工造出滚动位置。 */
  function fakeLayout(
    panel: ToolairlockChatPanel,
    position: { scrollHeight: number, clientHeight: number, scrollTop: number }
  ): HTMLElement {
    const log = partOf(panel, 'log')!
    Object.defineProperty(log, 'scrollHeight', {
      value: position.scrollHeight, configurable: true
    })
    Object.defineProperty(log, 'clientHeight', {
      value: position.clientHeight, configurable: true
    })
    Object.defineProperty(log, 'scrollTop', {
      value: position.scrollTop, writable: true, configurable: true
    })
    return log
  }

  const entries = [{ id: '1', role: 'user' as const, content: 'x', at: 1 }]

  it('贴底时不显示回到最新按钮', () => {
    const panel = mount({ entries })
    const log = fakeLayout(panel, { scrollHeight: 1000, clientHeight: 400, scrollTop: 600 })

    log.dispatchEvent(new Event('scroll'))

    expect((partOf(panel, 'jump') as HTMLButtonElement).hidden).toBe(true)
  })

  it('往回翻历史时给出回到最新的路', () => {
    const panel = mount({ entries })
    const log = fakeLayout(panel, { scrollHeight: 1000, clientHeight: 400, scrollTop: 100 })

    log.dispatchEvent(new Event('scroll'))

    expect((partOf(panel, 'jump') as HTMLButtonElement).hidden).toBe(false)
  })

  it('点击回到最新即滚到底并收起按钮', () => {
    const panel = mount({ entries })
    const log = fakeLayout(panel, { scrollHeight: 1000, clientHeight: 400, scrollTop: 100 })
    log.dispatchEvent(new Event('scroll'))

    ;(partOf(panel, 'jump') as HTMLButtonElement).click()

    expect(log.scrollTop).toBe(1000)
    expect((partOf(panel, 'jump') as HTMLButtonElement).hidden).toBe(true)
  })

  it('用户翻在历史里时新消息不把他拽回底部', () => {
    const panel = mount({ entries })
    const log = fakeLayout(panel, { scrollHeight: 1000, clientHeight: 400, scrollTop: 100 })

    panel.state = {
      entries: [...entries, { id: '2', role: 'assistant', content: 'y', at: 2 }],
      status: 'idle'
    }

    expect(log.scrollTop).toBe(100)
    expect((partOf(panel, 'jump') as HTMLButtonElement).hidden).toBe(false)
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

describe('标题栏动作', () => {
  it('提供新建对话与关闭两个动作，新建在左、关闭在右', () => {
    const panel = mount()

    const labels = partsOf(panel, 'action').map(node => node.getAttribute('aria-label'))
    expect(labels).toEqual(['新建对话', '关闭助手'])
  })

  it('点关闭派发 close，宿主或悬浮壳据此收起', () => {
    const panel = mount()
    const listener = vi.fn()
    panel.addEventListener('close', listener)

    partOf(panel, 'close')?.click()

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('点新建派发 new-chat，由宿主决定怎么清——面板自己不持有状态', () => {
    const panel = mount({ entries: [{ id: '1', role: 'user', content: 'x', at: 1 }] })
    const listener = vi.fn()
    panel.addEventListener('new-chat', listener)

    partOf(panel, 'new-chat')?.click()

    expect(listener).toHaveBeenCalledTimes(1)
    // 面板不自作主张清空：状态没回来之前，界面上还是原来那一条
    expect(partsOf(panel, 'entry')).toHaveLength(1)
  })

  it('事件冒泡且穿透 Shadow DOM，宿主在容器上监听即可', () => {
    // 要有内容，否则新建按钮是禁用的，点了本就不该有事件
    const panel = mount({ entries: [{ id: '1', role: 'user', content: 'x', at: 1 }] })
    const seen: string[] = []
    document.body.addEventListener('close', () => seen.push('close'))
    document.body.addEventListener('new-chat', () => seen.push('new-chat'))

    partOf(panel, 'new-chat')?.click()
    partOf(panel, 'close')?.click()

    expect(seen).toEqual(['new-chat', 'close'])
  })

  it('执行中不许新建——上一轮还没了结，清空会让运行中的 Run 失去落点', () => {
    const panel = mount({ status: 'busy' })

    expect((partOf(panel, 'new-chat') as HTMLButtonElement).disabled).toBe(true)
    // 关闭任何时候都能点：收起不影响 Run，用户随时可以让它让位
    expect((partOf(panel, 'close') as HTMLButtonElement).disabled).toBe(false)
  })

  it('空会话时新建也不可点，避免一个什么都不做的按钮', () => {
    const panel = mount()

    expect((partOf(panel, 'new-chat') as HTMLButtonElement).disabled).toBe(true)
  })
})
