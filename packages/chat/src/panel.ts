import type { ChatConfirmation, ChatEntry, ChatState } from './protocol'

/**
 * 聊天面板，原生自定义元素 + Shadow DOM。
 *
 * 与 `@toolairlock/ui` 的分工：那边是**安全承重**组件（确认卡片、遮罩），结构不许裁剪；
 * 这边是**产品**组件，完全可以被接入方替换掉——只要照样把 {@link ChatState} 渲染出来、
 * 把用户动作派发出去即可。
 *
 * 面板自己不持有状态：`state` 进、事件出。这样它与 {@link ChatSession} 之间只有一条
 * 单向数据流，接入方也能把同一个会话同时接到自己的 React / Vue 组件上。
 *
 * 确认卡片**不由本组件渲染**：它是治理层唯一面向人的界面，理应由 `@toolairlock/ui`
 * 那个不可裁剪的实现负责。本组件只留一个挂载点，宿主把 `<toolairlock-confirm>` 放进来。
 */

const STYLE = `
:host { display: flex; flex-direction: column; height: 100%; min-height: 0;
  font-family: var(--tal-font, system-ui, -apple-system, "PingFang SC", sans-serif);
  color: var(--tal-fg, #1f2329); background: var(--tal-bg, #fff); font-size: 14px; }
[part="log"] { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 16px;
  display: flex; flex-direction: column; gap: 12px; }
[part="entry"] { display: flex; flex-direction: column; gap: 4px; max-width: 85%; }
[part="entry"][data-role="user"] { align-self: flex-end; align-items: flex-end; }
[part="bubble"] { padding: 8px 12px; border-radius: var(--tal-radius, 8px);
  background: var(--tal-bubble-bg, #f4f5f7); line-height: 1.6; white-space: pre-wrap;
  word-break: break-word; }
[data-role="user"] [part="bubble"] { background: var(--tal-user-bg, #2b6cb0); color: #fff; }
[data-role="tool"] [part="bubble"] { background: transparent; padding: 2px 0;
  color: #6b7280; font-size: 13px; }
[data-role="tool"][data-ok="false"] [part="bubble"] { color: var(--tal-danger, #d64545); }
[part="tools"] { display: flex; flex-wrap: wrap; gap: 6px; }
[part="tool-chip"] { padding: 2px 8px; border-radius: 999px; background: #eef2f7;
  color: #4b5563; font-size: 12px;
  font-family: var(--tal-mono, ui-monospace, SFMono-Regular, Menlo, monospace); }
[part="cursor"] { display: inline-block; width: 7px; height: 1em; vertical-align: -2px;
  background: currentColor; animation: tal-blink 1s steps(2) infinite; }
@keyframes tal-blink { 0%, 50% { opacity: 1 } 50.01%, 100% { opacity: 0 } }
[part="error"] { margin: 0 16px; padding: 8px 12px; border-radius: 6px;
  background: #fdf2f2; color: var(--tal-danger, #d64545); }
[part="confirmation"]:empty { display: none; }
[part="confirmation"] { padding: 0 16px 12px; }
[part="composer"] { display: flex; gap: 8px; padding: 12px 16px;
  border-top: 1px solid var(--tal-border, #dfe2e8); }
[part="input"] { flex: 1 1 auto; padding: 8px 12px; font: inherit; resize: none;
  border: 1px solid var(--tal-border, #dfe2e8); border-radius: var(--tal-radius, 8px);
  color: inherit; background: inherit; }
[part="input"]:disabled { opacity: .6; }
[part="send"] { padding: 8px 18px; font: inherit; cursor: pointer; color: #fff;
  border: none; border-radius: var(--tal-radius, 8px); background: var(--tal-user-bg, #2b6cb0); }
[part="send"]:disabled { opacity: .5; cursor: default; }
[part="empty"] { margin: auto; color: #9ca3af; }
`

/** 角色对应的展示前缀。tool 结果用符号，避免与助手发言混淆。 */
const TOOL_PREFIX = { true: '✓ ', false: '✕ ' }

export class ToolairlockChatPanel extends HTMLElement {
  private readonly root: ShadowRoot
  private current: ChatState = { entries: [], status: 'idle' }
  private log!: HTMLElement
  private confirmationSlot!: HTMLElement
  private errorBox!: HTMLElement
  private input!: HTMLTextAreaElement
  private sendButton!: HTMLButtonElement
  private built = false

  constructor() {
    super()
    this.root = this.attachShadow({ mode: 'open' })
  }

  /** 设置状态即触发重绘。这是本组件唯一的输入。 */
  set state(value: ChatState) {
    this.current = value
    this.render()
  }

  get state(): ChatState {
    return this.current
  }

  connectedCallback(): void {
    this.build()
    this.render()
  }

  /** 确认卡片的挂载点。宿主把 `<toolairlock-confirm>` 放进来。 */
  get confirmationHost(): HTMLElement {
    this.build()
    return this.confirmationSlot
  }

  private build(): void {
    if (this.built) return
    this.built = true

    const style = document.createElement('style')
    style.textContent = STYLE

    this.log = document.createElement('div')
    this.log.setAttribute('part', 'log')
    this.log.setAttribute('role', 'log')
    this.log.setAttribute('aria-live', 'polite')

    this.errorBox = document.createElement('div')
    this.errorBox.setAttribute('part', 'error')
    this.errorBox.setAttribute('role', 'alert')

    this.confirmationSlot = document.createElement('div')
    this.confirmationSlot.setAttribute('part', 'confirmation')

    const composer = document.createElement('div')
    composer.setAttribute('part', 'composer')

    this.input = document.createElement('textarea')
    this.input.setAttribute('part', 'input')
    this.input.rows = 1
    this.input.placeholder = '说点什么…'
    this.input.setAttribute('aria-label', '输入消息')
    // Enter 发送、Shift+Enter 换行——聊天界面的通用约定。
    this.input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        this.send()
      }
    })

    this.sendButton = document.createElement('button')
    this.sendButton.setAttribute('part', 'send')
    this.sendButton.type = 'button'
    this.sendButton.textContent = '发送'
    this.sendButton.addEventListener('click', () => this.send())

    composer.append(this.input, this.sendButton)
    this.root.append(style, this.log, this.errorBox, this.confirmationSlot, composer)
  }

  private send(): void {
    const text = this.input.value.trim()
    if (!text || this.isLocked()) return
    this.input.value = ''
    this.dispatchEvent(new CustomEvent('send', {
      bubbles: true, composed: true, detail: { text }
    }))
  }

  /** 忙碌或等待确认时不接受新输入——两者都意味着上一轮还没了结。 */
  private isLocked(): boolean {
    return this.current.status !== 'idle'
  }

  private render(): void {
    if (!this.built) return
    this.renderLog()
    this.errorBox.textContent = this.current.error ?? ''
    this.errorBox.style.display = this.current.error ? '' : 'none'
    const locked = this.isLocked()
    this.input.disabled = locked
    this.sendButton.disabled = locked
  }

  private renderLog(): void {
    // 重绘前记录是否贴底：用户往回翻历史时不该被新消息拽回去。
    const wasAtBottom = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 40
    this.log.replaceChildren()

    if (this.current.entries.length === 0) {
      const empty = document.createElement('div')
      empty.setAttribute('part', 'empty')
      empty.textContent = '还没有对话'
      this.log.appendChild(empty)
      return
    }

    this.current.entries.forEach(entry => {
      this.log.appendChild(this.renderEntry(entry))
    })
    if (wasAtBottom) this.log.scrollTop = this.log.scrollHeight
  }

  /**
   * 渲染一条消息。
   *
   * 全程 `textContent`，绝不用 `innerHTML`：消息内容来自模型与业务数据，用富文本
   * 方式渲染就是在治理层自己的界面上开一个注入口。
   */
  private renderEntry(entry: ChatEntry): HTMLElement {
    const wrapper = document.createElement('div')
    wrapper.setAttribute('part', 'entry')
    wrapper.setAttribute('data-role', entry.role)
    if (entry.ok !== undefined) wrapper.setAttribute('data-ok', String(entry.ok))

    if (entry.content || entry.streaming) {
      const bubble = document.createElement('div')
      bubble.setAttribute('part', 'bubble')
      const prefix = entry.role === 'tool' && entry.ok !== undefined
        ? TOOL_PREFIX[String(entry.ok) as 'true' | 'false']
        : ''
      bubble.textContent = prefix + entry.content
      if (entry.streaming) {
        const cursor = document.createElement('span')
        cursor.setAttribute('part', 'cursor')
        bubble.appendChild(cursor)
      }
      wrapper.appendChild(bubble)
    }

    if (entry.toolCalls?.length) {
      const tools = document.createElement('div')
      tools.setAttribute('part', 'tools')
      entry.toolCalls.forEach(call => {
        const chip = document.createElement('span')
        chip.setAttribute('part', 'tool-chip')
        chip.textContent = call.function.name
        tools.appendChild(chip)
      })
      wrapper.appendChild(tools)
    }

    return wrapper
  }
}

/** 元素名。重复注册跳过，便于热更新与多次引入下保持幂等。 */
export const CHAT_PANEL_TAG = 'toolairlock-chat'

if (typeof customElements !== 'undefined' && !customElements.get(CHAT_PANEL_TAG)) {
  customElements.define(CHAT_PANEL_TAG, ToolairlockChatPanel)
}

/** 面板派发的事件载荷。 */
export interface ChatPanelSendDetail {
  text: string
}

export type { ChatConfirmation }
