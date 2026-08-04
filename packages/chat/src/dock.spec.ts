import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CHAT_DOCK_TAG, DOCK_LAYER, WandkitChatDock } from './dock'
import type { ChatState } from './protocol'

function mount(): WandkitChatDock {
  const dock = document.createElement(CHAT_DOCK_TAG) as WandkitChatDock
  const content = document.createElement('div')
  content.id = 'content'
  dock.appendChild(content)
  document.body.appendChild(dock)
  return dock
}

function partOf(dock: WandkitChatDock, name: string): HTMLElement {
  const node = dock.shadowRoot?.querySelector(`[part="${name}"]`)
  if (!node) throw new Error(`缺少 part="${name}"`)
  return node as HTMLElement
}

function stateOf(patch?: Partial<ChatState>): ChatState {
  return { entries: [], status: 'idle', ...patch }
}

const confirmation = {
  confirmationId: 'c1',
  toolCallId: 't1',
  functionName: 'http.request',
  title: '确认写操作',
  rows: [],
  risk: 'write' as const
}

beforeEach(() => {
  document.body.replaceChildren()
})

describe('收起与展开', () => {
  it('默认收起，只露出一个图标', () => {
    const dock = mount()

    expect(dock.open).toBe(false)
    expect(partOf(dock, 'frame').hidden).toBe(true)
    expect(partOf(dock, 'launcher').getAttribute('aria-expanded')).toBe('false')
  })

  it('点击图标展开；收起交给面板上的关闭按钮，图标此时已让位', () => {
    const dock = mount()
    const launcher = partOf(dock, 'launcher')

    launcher.click()
    expect(dock.open).toBe(true)
    expect(partOf(dock, 'frame').hidden).toBe(false)
    expect(launcher.getAttribute('aria-expanded')).toBe('true')
  })

  it('open 属性可由宿主直接写，并反射到 DOM 上', () => {
    const dock = mount()

    dock.open = true
    expect(dock.hasAttribute('open')).toBe(true)

    dock.open = false
    expect(dock.hasAttribute('open')).toBe(false)
  })

  it('切换时派发 dock-toggle，宿主可据此记住偏好', () => {
    const dock = mount()
    const seen: boolean[] = []
    dock.addEventListener('dock-toggle', (event: Event) => {
      seen.push((event as CustomEvent<{ open: boolean }>).detail.open)
    })

    partOf(dock, 'launcher').click()
    dock.querySelector('#content')!.dispatchEvent(
      new CustomEvent('close', { bubbles: true, composed: true })
    )

    expect(seen).toEqual([true, false])
  })

  it('重复设成同一状态不重复派发事件', () => {
    const dock = mount()
    const listener = vi.fn()
    dock.addEventListener('dock-toggle', listener)

    dock.open = false
    dock.open = true
    dock.open = true

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('Esc 收起面板', () => {
    const dock = mount()
    dock.open = true

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))

    expect(dock.open).toBe(false)
  })

  it('收起不销毁内容，会话不会因为收起而丢失', () => {
    const dock = mount()
    dock.open = true
    dock.open = false

    expect(dock.querySelector('#content')).not.toBeNull()
  })
})

describe('状态与提醒', () => {
  it('状态映射到图标上，且用无障碍名称说清当前在做什么', () => {
    const dock = mount()

    dock.state = stateOf({ status: 'busy' })

    const launcher = partOf(dock, 'launcher')
    expect(launcher.getAttribute('data-status')).toBe('busy')
    expect(launcher.getAttribute('aria-label')).toContain('执行中')
  })

  it('收起时忙碌带角标，展开后角标撤掉', () => {
    const dock = mount()

    dock.state = stateOf({ status: 'busy' })
    expect(partOf(dock, 'badge').hidden).toBe(false)

    dock.open = true
    expect(partOf(dock, 'badge').hidden).toBe(true)
  })

  it('出现待确认时强制展开——收起状态下治理界面绝不能被藏起来', () => {
    const dock = mount()

    dock.state = stateOf({ status: 'awaiting_confirmation', confirmation })

    expect(dock.open).toBe(true)
  })

  it('出现错误时同样强制展开', () => {
    const dock = mount()

    dock.state = stateOf({ error: 'LLM 代理 502' })

    expect(dock.open).toBe(true)
  })

  it('确认结束后不自动收起——用户此刻多半要看结果', () => {
    const dock = mount()

    dock.state = stateOf({ status: 'awaiting_confirmation', confirmation })
    dock.state = stateOf({ status: 'idle' })

    expect(dock.open).toBe(true)
  })

  it('用户手动收起后，同一个待确认项不会把面板重新弹开', () => {
    const dock = mount()

    dock.state = stateOf({ status: 'awaiting_confirmation', confirmation })
    dock.open = false
    dock.state = stateOf({ status: 'awaiting_confirmation', confirmation })

    expect(dock.open).toBe(false)
  })

  it('换成另一个待确认项时重新强制展开', () => {
    const dock = mount()

    dock.state = stateOf({ status: 'awaiting_confirmation', confirmation })
    dock.open = false
    dock.state = stateOf({
      status: 'awaiting_confirmation',
      confirmation: { ...confirmation, confirmationId: 'c2' }
    })

    expect(dock.open).toBe(true)
  })
})

describe('层级', () => {
  it('压过遮罩层——面板里就是确认卡片，被罩住等于治理失效', () => {
    // @wandkit/ui 的 MASK_LAYER 是 2147483646，这里必须再高一级
    expect(DOCK_LAYER).toBeGreaterThan(2147483646)
  })

  it('图标与面板都用同一层级，收起态也不会被宿主弹层埋掉', () => {
    const dock = mount()

    const css = dock.shadowRoot?.textContent ?? ''
    expect(css).toContain(`z-index: ${DOCK_LAYER}`)
  })
})

describe('与内容的协作', () => {
  it('内容里冒泡上来的 close 收起面板——面板上的关闭按钮不必知道壳的存在', () => {
    const dock = mount()
    dock.open = true

    dock.querySelector('#content')!.dispatchEvent(
      new CustomEvent('close', { bubbles: true, composed: true })
    )

    expect(dock.open).toBe(false)
  })

  it('展开时收起图标——它被面板压住只剩一角，那种半遮的按钮只会让人以为点不了', () => {
    const dock = mount()

    expect(partOf(dock, 'launcher').hidden).toBe(false)
    dock.open = true
    expect(partOf(dock, 'launcher').hidden).toBe(true)
  })
})
