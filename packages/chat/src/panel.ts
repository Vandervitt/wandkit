import type { ChatConfirmation, ChatEntry, ChatState, ChatStatus } from './protocol'

/**
 * 聊天面板，原生自定义元素 + Shadow DOM。
 *
 * 与 `@toolairlock/ui` 的分工：那边是**安全承重**组件（确认卡片、遮罩），结构不许裁剪；
 * 这边是**产品**组件，完全可以被接入方替换掉——只要照样把 {@link ChatState} 渲染出来、
 * 把用户动作派发出去即可。
 *
 * 面板自己不持有状态：`state` 进、事件出。这样它与 `ChatSession` 之间只有一条
 * 单向数据流，接入方也能把同一个会话同时接到自己的 React / Vue 组件上。
 *
 * 确认卡片**不由本组件渲染**：它是治理层唯一面向人的界面，理应由 `@toolairlock/ui`
 * 那个不可裁剪的实现负责。本组件只留一个挂载点，宿主把 `<toolairlock-confirm>` 放进来。
 *
 * 视觉上与确认卡片共用一套亮色液态玻璃语言，这样卡片落在面板里不像外来物；同时面板自己
 * 的玻璃层比卡片轻一档，保证卡片始终是视觉重心——它是需要人做决定的那一块。
 */

const STYLE = `
:host {
  --_fg: var(--tal-fg, #0f1729);
  --_dim: var(--tal-dim, #64748b);
  --_faint: var(--tal-faint, #94a2b8);
  --_line: var(--tal-border, rgba(15, 23, 41, .09));
  --_glass: var(--tal-glass, rgba(255, 255, 255, .62));
  --_accent: var(--tal-accent, #0a84ff);
  --_success: var(--tal-success, #30c95f);
  --_danger: var(--tal-danger, #ff3b30);
  display: flex; flex-direction: column; height: 100%; min-height: 0;
  font-family: var(--tal-font, system-ui, -apple-system, "PingFang SC", sans-serif);
  font-size: 14px; letter-spacing: -.01em; color: var(--_fg);
  background:
    radial-gradient(70% 45% at 12% 4%, rgba(10, 132, 255, .2), transparent 62%),
    radial-gradient(60% 40% at 92% 20%, rgba(48, 201, 95, .14), transparent 60%),
    radial-gradient(80% 50% at 60% 104%, rgba(255, 59, 48, .11), transparent 62%),
    var(--tal-bg, linear-gradient(160deg, #eef2f8, #e3e8f0));
}

[part="header"] {
  flex: 0 0 auto; display: flex; align-items: center; gap: 10px;
  height: 50px; padding: 0 18px;
  background: rgba(255, 255, 255, .55);
  -webkit-backdrop-filter: blur(24px) saturate(1.6);
  backdrop-filter: blur(24px) saturate(1.6);
  border-bottom: 1px solid rgba(255, 255, 255, .8);
  box-shadow: 0 1px 0 rgba(15, 23, 41, .05);
}
[part="heading"] { font-size: 14px; font-weight: 600; letter-spacing: -.02em; }
[part="header"] .spacer { flex: 1 1 auto; }
[part="status"] {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 10px 4px 8px; border-radius: 999px;
  font-size: 11.5px; font-weight: 550;
  background: rgba(15, 23, 41, .06); color: var(--_dim);
}
[part="status"][data-status="busy"] { background: rgba(10, 132, 255, .12); color: #0a6ed1; }
[part="status"][data-status="awaiting_confirmation"] {
  background: rgba(255, 59, 48, .12); color: #c0271d;
}
[part="status-dot"] {
  width: 6px; height: 6px; border-radius: 50%; background: currentColor;
}

[part~="action"] {
  flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; padding: 0; cursor: pointer;
  border: 0; border-radius: 8px; background: transparent; color: var(--_dim);
  transition: background .14s ease, color .14s ease;
}
[part~="action"]:hover:not(:disabled) { background: rgba(15, 23, 41, .07); color: var(--_fg); }
[part~="action"]:focus-visible { outline: 2px solid var(--_accent); outline-offset: -1px; }
[part~="action"]:disabled { opacity: .32; cursor: default; }
[part~="action"] svg { width: 15px; height: 15px; }
[part="status"][data-status="busy"] [part="status-dot"],
[part="status"][data-status="awaiting_confirmation"] [part="status-dot"] {
  animation: tal-pulse 1.8s ease-in-out infinite;
}

[part="progress"] { flex: 0 0 auto; height: 1px; overflow: hidden; background: transparent; }
[part="progress"][data-active="true"] { background: rgba(10, 132, 255, .14); }
[part="progress-bar"] { display: block; height: 100%; }
[part="progress"][data-active="true"] [part="progress-bar"] {
  background: linear-gradient(90deg, transparent, var(--_accent), transparent);
  animation: tal-sweep 2.1s ease-in-out infinite;
}

[part="log-wrap"] { position: relative; flex: 1 1 auto; min-height: 0; display: flex; }
[part="log"] {
  flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 18px;
  display: flex; flex-direction: column; gap: 15px;
}
[part="empty"] { margin: auto; color: var(--_faint); font-size: 13.5px; }

[part="entry"] { display: flex; flex-direction: column; gap: 4px; max-width: 88%; }
[part="entry"][data-role="user"] { align-self: flex-end; align-items: flex-end; }
[part="bubble"] {
  padding: 10px 15px; border-radius: 20px 20px 20px 6px; line-height: 1.66;
  white-space: pre-wrap; word-break: break-word;
  background: var(--_glass);
  -webkit-backdrop-filter: blur(18px) saturate(1.5);
  backdrop-filter: blur(18px) saturate(1.5);
  border: 1px solid rgba(255, 255, 255, .9);
  box-shadow: 0 8px 20px -14px rgba(15, 23, 41, .34);
}
[data-role="user"] [part="bubble"] {
  border-radius: 20px 20px 6px 20px; border-color: transparent; color: #fff;
  background: linear-gradient(#3d9bff, #0a7ff0);
  box-shadow: 0 10px 22px -12px rgba(10, 132, 255, .8), inset 0 1px 0 rgba(255, 255, 255, .35);
}

/* 进度行：一句话说明正在做什么。刻意做得比气泡轻——它是过渡态，不是对话内容。 */
[part="step"] {
  display: flex; align-items: center; gap: 8px; align-self: flex-start;
  padding: 7px 13px; border-radius: 999px; max-width: 88%;
  background: rgba(255, 255, 255, .55);
  -webkit-backdrop-filter: blur(16px);
  backdrop-filter: blur(16px);
  border: 1px solid rgba(255, 255, 255, .85);
  color: var(--_dim); font-size: 12.5px;
}
[part="step-spinner"] {
  flex: 0 0 auto; width: 11px; height: 11px; border-radius: 50%;
  border: 1.5px solid rgba(10, 132, 255, .25); border-top-color: #0a7ff0;
  animation: tal-step-spin .7s linear infinite;
}
[part="step-label"] { white-space: pre-wrap; word-break: break-word; }
@keyframes tal-step-spin { to { transform: rotate(360deg); } }
/* 用户把动效关掉时，转圈就该停——但指示本身必须留着，否则忙碌态没有任何提示。 */
@media (prefers-reduced-motion: reduce) {
  [part="step-spinner"] { animation: none; }
}

[part="time"] {
  font-size: 11px; color: var(--_faint);
  font-family: var(--tal-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-variant-numeric: tabular-nums;
}
[part="cursor"] {
  display: inline-block; width: 6px; height: 1em; vertical-align: -2px; border-radius: 1px;
  background: currentColor; animation: tal-blink 1.05s steps(2) infinite;
}

[part="jump"] {
  position: absolute; right: 16px; bottom: 14px;
  width: 34px; height: 34px; padding: 0; border-radius: 50%; cursor: pointer;
  font: inherit; font-size: 15px; line-height: 1; color: var(--_fg);
  background: rgba(255, 255, 255, .8);
  -webkit-backdrop-filter: blur(20px) saturate(1.7);
  backdrop-filter: blur(20px) saturate(1.7);
  border: 1px solid rgba(255, 255, 255, .95);
  box-shadow: 0 12px 28px -12px rgba(15, 23, 41, .45);
}
[part="jump"][hidden] { display: none; }

[part="error"] {
  margin: 0 18px 4px; padding: 9px 13px; border-radius: 13px; font-size: 13px;
  background: rgba(255, 59, 48, .11); color: #a92018;
}
[part="confirmation"] { padding: 4px 16px 14px; }
[part="confirmation"]:empty { display: none; }

[part="composer"] {
  flex: 0 0 auto; display: flex; align-items: flex-end; gap: 10px; padding: 13px 18px;
  background: rgba(255, 255, 255, .55);
  -webkit-backdrop-filter: blur(24px) saturate(1.6);
  backdrop-filter: blur(24px) saturate(1.6);
  border-top: 1px solid rgba(255, 255, 255, .85);
}
[part="input"] {
  flex: 1 1 auto; padding: 10px 15px; font: inherit; resize: none; overflow-y: auto;
  max-height: 132px; border-radius: 20px; color: inherit;
  background: rgba(255, 255, 255, .9); border: 1px solid rgba(15, 23, 41, .1);
}
[part="input"]:focus { outline: 2px solid rgba(10, 132, 255, .45); outline-offset: -1px; }
[part="input"]:disabled { background: rgba(255, 255, 255, .5); color: var(--_dim); }
[part="send"] {
  flex: 0 0 auto; padding: 10px 18px; font: inherit; font-weight: 550; cursor: pointer;
  border: none; border-radius: 999px; color: #fff;
  background: linear-gradient(#3d9bff, #0a7ff0);
  box-shadow: 0 10px 22px -12px rgba(10, 132, 255, .9), inset 0 1px 0 rgba(255, 255, 255, .38);
}
[part="send"]:disabled {
  cursor: default; color: var(--_faint); background: rgba(15, 23, 41, .07); box-shadow: none;
}

@keyframes tal-blink { 0%, 50% { opacity: 1 } 50.01%, 100% { opacity: 0 } }
@keyframes tal-pulse { 50% { opacity: .3 } }
@keyframes tal-sweep {
  0% { transform: translateX(-100%) } 100% { transform: translateX(100%) }
}
@media (prefers-reduced-motion: reduce) {
  [part="status-dot"], [part="progress-bar"], [part="cursor"] { animation: none !important; }
}
`

/** 还没有任何步骤完成时的进度文案。见 {@link ChatState.progress}。 */
const PROGRESS_FALLBACK = '正在处理…'

/** 状态在界面上的说法。回答的是「我现在能不能说话」。 */
const STATUS_LABEL: Record<ChatStatus, string> = {
  idle: '就绪',
  busy: '执行中',
  awaiting_confirmation: '等待确认'
}

/**
 * 输入框占位文案随状态变化。
 *
 * 锁住输入却不说原因，用户只会觉得界面坏了——尤其 `awaiting_confirmation`，此时该做的
 * 事在屏幕别处（确认卡片上），不指路他就卡在这儿。
 */
const PLACEHOLDER: Record<ChatStatus, string> = {
  idle: '说点什么…',
  busy: '执行中，请稍候…',
  awaiting_confirmation: '请先处理上方的确认卡片'
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * 标题栏动作图标。
 *
 * 新建对话用垃圾桶而不是加号：这个动作的**代价**是清掉当前这段会话，而加号只说了得到
 * 什么、没说失去什么。用户在这里犹豫一下是好事。
 */
const ACTION_ICONS = {
  'new-chat': ['M4 6.5h12', 'M8 6.5V4.8h4v1.7', 'M6 6.5l.8 8.2h6.4l.8-8.2'],
  close: ['M5.5 5.5l9 9', 'M14.5 5.5l-9 9']
}

/** 判定「贴底」的容差。用户往回翻历史时不该被新消息拽回去。 */
const BOTTOM_SLACK = 40

/** 输入框自增高的上限，约 5 行。 */
const INPUT_MAX_HEIGHT = 132

/** 只显示时分：面板里的相对时序才是有用的信息，日期由业务侧的会话列表负责。 */
function formatTime(at: number): string {
  const time = new Date(at)
  if (Number.isNaN(time.getTime())) return ''
  const hours = String(time.getHours()).padStart(2, '0')
  const minutes = String(time.getMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
}

export class ToolairlockChatPanel extends HTMLElement {
  private readonly root: ShadowRoot
  private current: ChatState = { entries: [], status: 'idle' }
  private headingText = '助手'
  private log!: HTMLElement
  private headingNode!: HTMLElement
  private statusNode!: HTMLElement
  private statusLabel!: HTMLElement
  private progress!: HTMLElement
  private jumpButton!: HTMLButtonElement
  private confirmationSlot!: HTMLElement
  private errorBox!: HTMLElement
  private input!: HTMLTextAreaElement
  private sendButton!: HTMLButtonElement
  private newChatButton!: HTMLButtonElement
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

  /** 标题栏文案。产品名由宿主决定，本包不往里塞自己的品牌。 */
  set heading(value: string) {
    this.headingText = value
    if (this.built) this.headingNode.textContent = value
  }

  get heading(): string {
    return this.headingText
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

    this.root.append(
      style,
      this.buildHeader(),
      this.buildLog(),
      this.buildErrorBox(),
      this.buildConfirmationSlot(),
      this.buildComposer()
    )
  }

  private buildHeader(): DocumentFragment {
    const fragment = document.createDocumentFragment()

    const header = document.createElement('div')
    header.setAttribute('part', 'header')

    this.headingNode = document.createElement('div')
    this.headingNode.setAttribute('part', 'heading')
    this.headingNode.textContent = this.headingText

    const spacer = document.createElement('span')
    spacer.className = 'spacer'

    this.statusNode = document.createElement('span')
    this.statusNode.setAttribute('part', 'status')
    const dot = document.createElement('span')
    dot.setAttribute('part', 'status-dot')
    this.statusLabel = document.createElement('span')
    this.statusNode.append(dot, this.statusLabel)

    // 新建在左、关闭在右：关闭是最靠边、最不容易误触到别的东西的位置，符合窗口类
    // 界面的通用位置约定。
    this.newChatButton = this.buildAction('new-chat', '新建对话')
    const closeButton = this.buildAction('close', '关闭助手')

    header.append(
      this.headingNode, spacer, this.statusNode, this.newChatButton, closeButton
    )

    this.progress = document.createElement('div')
    this.progress.setAttribute('part', 'progress')
    const bar = document.createElement('span')
    bar.setAttribute('part', 'progress-bar')
    this.progress.appendChild(bar)

    fragment.append(header, this.progress)
    return fragment
  }

  /**
   * 标题栏上的一个动作按钮。
   *
   * 两个动作都**只派发事件，不自己动手**——面板不持有状态，清空会话得由持有它的一方
   * 来做；收起与否更是壳的事，面板不该知道自己被装在什么里面。
   */
  private buildAction(name: 'new-chat' | 'close', label: string): HTMLButtonElement {
    const button = document.createElement('button')
    button.setAttribute('part', `action ${name}`)
    button.type = 'button'
    button.setAttribute('aria-label', label)
    button.title = label

    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('viewBox', '0 0 20 20')
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '1.6')
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('stroke-linejoin', 'round')
    svg.setAttribute('aria-hidden', 'true')
    ACTION_ICONS[name].forEach(d => {
      const path = document.createElementNS(SVG_NS, 'path')
      path.setAttribute('d', d)
      svg.appendChild(path)
    })
    button.appendChild(svg)

    button.addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent(name, { bubbles: true, composed: true }))
    })
    return button
  }

  private buildLog(): HTMLElement {
    const wrap = document.createElement('div')
    wrap.setAttribute('part', 'log-wrap')

    this.log = document.createElement('div')
    this.log.setAttribute('part', 'log')
    this.log.setAttribute('role', 'log')
    this.log.setAttribute('aria-live', 'polite')
    this.log.addEventListener('scroll', () => this.syncJumpButton())

    // 往回翻历史时给一条回到最新的路。没有它，长会话里用户只能一路手动滚。
    this.jumpButton = document.createElement('button')
    this.jumpButton.setAttribute('part', 'jump')
    this.jumpButton.type = 'button'
    this.jumpButton.textContent = '↓'
    this.jumpButton.setAttribute('aria-label', '回到最新消息')
    this.jumpButton.hidden = true
    this.jumpButton.addEventListener('click', () => this.scrollToBottom())

    wrap.append(this.log, this.jumpButton)
    return wrap
  }

  private buildErrorBox(): HTMLElement {
    this.errorBox = document.createElement('div')
    this.errorBox.setAttribute('part', 'error')
    this.errorBox.setAttribute('role', 'alert')
    return this.errorBox
  }

  private buildConfirmationSlot(): HTMLElement {
    this.confirmationSlot = document.createElement('div')
    this.confirmationSlot.setAttribute('part', 'confirmation')
    return this.confirmationSlot
  }

  private buildComposer(): HTMLElement {
    const composer = document.createElement('div')
    composer.setAttribute('part', 'composer')

    this.input = document.createElement('textarea')
    this.input.setAttribute('part', 'input')
    this.input.rows = 1
    this.input.placeholder = PLACEHOLDER.idle
    this.input.setAttribute('aria-label', '输入消息')
    // Enter 发送、Shift+Enter 换行——聊天界面的通用约定。
    this.input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        this.send()
      }
    })
    this.input.addEventListener('input', () => this.autoGrow())

    this.sendButton = document.createElement('button')
    this.sendButton.setAttribute('part', 'send')
    this.sendButton.type = 'button'
    this.sendButton.textContent = '发送'
    this.sendButton.addEventListener('click', () => this.send())

    composer.append(this.input, this.sendButton)
    return composer
  }

  /**
   * 输入框随内容长高。
   *
   * 固定单行会让多行输入变成一条只能看见最后一行的缝，用户没法在发出前检查自己写了什么。
   */
  private autoGrow(): void {
    this.input.style.height = 'auto'
    const wanted = this.input.scrollHeight
    // scrollHeight 为 0 意味着没有布局（未挂载、display:none 或 jsdom），
    // 此时写死一个 0px 高度只会把输入框压没了。
    this.input.style.height = wanted > 0 ? `${Math.min(wanted, INPUT_MAX_HEIGHT)}px` : ''
  }

  private send(): void {
    const text = this.input.value.trim()
    if (!text || this.isLocked()) return
    this.input.value = ''
    this.autoGrow()
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
    this.renderStatus()

    this.errorBox.textContent = this.current.error ?? ''
    this.errorBox.style.display = this.current.error ? '' : 'none'

    const locked = this.isLocked()
    this.input.disabled = locked
    this.sendButton.disabled = locked
    this.input.placeholder = PLACEHOLDER[this.current.status]
    // 空会话时清空是空动作；执行中清空更糟——Run 还在跑，抹掉历史会让接下来的
    // 助手发言落在一段没有来由的对话上。关闭按钮不受此限，收起不影响 Run。
    this.newChatButton.disabled = locked || this.current.entries.length === 0
  }

  private renderStatus(): void {
    const status = this.current.status
    this.statusNode.setAttribute('data-status', status)
    this.statusLabel.textContent = STATUS_LABEL[status]
    // 进度条只在真正在跑的时候动。等待确认时球在用户脚下，让条子继续扫会造成
    // 「系统还在忙」的错觉，人就不去点卡片了。
    this.progress.setAttribute('data-active', String(status === 'busy'))
  }

  private renderLog(): void {
    // 重绘前记录是否贴底：用户往回翻历史时不该被新消息拽回去。
    const wasAtBottom = this.isAtBottom()
    this.log.replaceChildren()

    if (this.current.entries.length === 0 && this.current.status !== 'busy') {
      const empty = document.createElement('div')
      empty.setAttribute('part', 'empty')
      empty.textContent = '还没有对话'
      this.log.appendChild(empty)
      this.jumpButton.hidden = true
      return
    }

    this.current.entries.forEach(entry => {
      this.log.appendChild(this.renderEntry(entry))
    })
    // 忙碌期间末尾挂一行进度。第一个工具跑完之前 progress 还是空的，用泛化文案兜住——
    // 那段时间恰恰是用户最容易以为「它没反应」的时候。
    if (this.current.status === 'busy') {
      this.log.appendChild(this.renderStep(this.current.progress || PROGRESS_FALLBACK))
    }
    if (wasAtBottom) this.scrollToBottom()
    else this.syncJumpButton()
  }

  private isAtBottom(): boolean {
    return this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < BOTTOM_SLACK
  }

  private scrollToBottom(): void {
    this.log.scrollTop = this.log.scrollHeight
    this.jumpButton.hidden = true
  }

  private syncJumpButton(): void {
    this.jumpButton.hidden = this.isAtBottom()
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

    if (entry.content || entry.streaming) {
      const bubble = document.createElement('div')
      bubble.setAttribute('part', 'bubble')
      bubble.textContent = entry.content
      if (entry.streaming) {
        const cursor = document.createElement('span')
        cursor.setAttribute('part', 'cursor')
        bubble.appendChild(cursor)
      }
      wrapper.appendChild(bubble)
    }

    const time = formatTime(entry.at)
    if (time) {
      const stamp = document.createElement('span')
      stamp.setAttribute('part', 'time')
      stamp.textContent = time
      wrapper.appendChild(stamp)
    }

    return wrapper
  }

  /**
   * 渲染进度行：一句业务语言，说明现在正在做什么。
   *
   * 它取代了逐条渲染工具调用。用户需要知道的是「还在动、动到哪儿了」，不是
   * `page_click_v1` 与元素下标——那些是执行细节，去 trace 里查。Run 一结束这一行
   * 就消失，只留下最终回答。
   */
  private renderStep(text: string): HTMLElement {
    const row = document.createElement('div')
    row.setAttribute('part', 'step')

    const spinner = document.createElement('span')
    spinner.setAttribute('part', 'step-spinner')
    // 纯装饰。读屏软件念一个转圈符号只会干扰，真正该被念出来的是后面那句话。
    spinner.setAttribute('aria-hidden', 'true')

    const label = document.createElement('span')
    label.setAttribute('part', 'step-label')
    label.textContent = text

    row.append(spinner, label)
    return row
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
