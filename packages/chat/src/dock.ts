import type { ChatState, ChatStatus } from './protocol'

/**
 * 悬浮壳——助手在宿主应用里的落脚方式。
 *
 * 存在的理由是它之前不存在：面板自己只声明 `height: 100%`，定位交给宿主。于是每个接入方
 * 都要手写一段 `position:fixed;right:0;top:0;bottom:0;width:400px` 的侧栏，结果是
 *
 * - 助手常驻压住右侧一整条，宿主应用的右侧操作区从此不能用；
 * - 没有收起，用户想让它让位只能整个卸掉。
 *
 * 那段样板不该由接入方各写一遍，更不该每次都写成侧栏。本组件给出的形态是：**收起时只是
 * 右下角一个图标，展开时是一块浮在应用之上的面板**——不参与宿主布局，不占据任何空间。
 *
 * 它是**产品**组件，和面板一样可以被接入方整个换掉；换掉时唯一必须保留的是
 * {@link WandkitChatDock.state} 里那条「待确认强制展开」的规则，那是治理不静默失效的
 * 前提，见下文。
 *
 * 与面板的分工：本组件只管「在不在、多大、在哪儿」，一个字的会话内容都不渲染。内容由
 * 插槽里的 `<wandkit-chat>`（或接入方自己的实现）负责。
 *
 * 可用的 part：`frame` `launcher` `badge` `icon`
 * 可用的变量：`--wandkit-dock-inset` `--wandkit-dock-width` `--wandkit-dock-height` `--wandkit-dock-size`
 *   `--wandkit-accent` `--wandkit-font`
 */

/**
 * 悬浮壳的层级。
 *
 * **必须高于 `@wandkit/ui` 的 `MASK_LAYER`（2147483646）**：确认卡片挂在面板里，
 * 而遮罩压过宿主的一切弹层——壳若在遮罩之下，Agent 干活期间弹出的卡片就点不动，Run 卡在
 * 等待确认而用户看不出原因（真实接入实测踩过，那次是靠临时撤掉遮罩绕开的）。
 *
 * 高于遮罩之后就不必再撤罩：遮罩的职责是挡住用户操作**宿主页面**，而治理界面本就该始终
 * 可点。两件事分开，比在时序上互相让位可靠。
 *
 * 这里用满 32 位有符号上限——遮罩刻意让出的正是这一档。
 */
export const DOCK_LAYER = 2147483647

/** 图标的无障碍名称。收起态要回答「这是什么」，展开态要回答「点了会怎样」。 */
const LAUNCHER_LABEL: Record<ChatStatus, string> = {
  idle: '打开助手',
  busy: '打开助手（执行中）',
  awaiting_confirmation: '打开助手（等待确认）'
}

const STYLE = `
:host {
  display: contents;
  --_inset: var(--wandkit-dock-inset, 24px);
  --_size: var(--wandkit-dock-size, 52px);
  --_accent: var(--wandkit-accent, #0a84ff);
}

[part="frame"] {
  position: fixed;
  right: var(--_inset);
  /* 展开时图标已让位，面板直接落到底部边距上。 */
  bottom: var(--_inset);
  z-index: ${DOCK_LAYER};
  display: flex;
  flex-direction: column;
  width: var(--wandkit-dock-width, 400px);
  max-width: calc(100vw - var(--_inset) * 2);
  height: var(--wandkit-dock-height, 620px);
  max-height: calc(100vh - var(--_inset) * 2);
  overflow: hidden;
  border-radius: 22px;
  border: 1px solid rgba(255, 255, 255, .9);
  box-shadow: 0 32px 72px -28px rgba(15, 23, 41, .5), 0 2px 8px -4px rgba(15, 23, 41, .18);
  animation: wandkit-dock-in .18s cubic-bezier(.2, .8, .3, 1);
  font-family: var(--wandkit-font, system-ui, -apple-system, "PingFang SC", sans-serif);
}
[part="frame"][hidden] { display: none; }
/* 插槽里的面板负责撑满壳；它自己只声明 height:100%，需要一个确定的高度来源。 */
::slotted(*) { flex: 1 1 auto; min-height: 0; }

[part="launcher"] {
  position: fixed;
  right: var(--_inset);
  bottom: var(--_inset);
  z-index: ${DOCK_LAYER};
  display: flex;
  align-items: center;
  justify-content: center;
  width: var(--_size);
  height: var(--_size);
  padding: 0;
  cursor: pointer;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, .9);
  color: #0f1729;
  background:
    radial-gradient(80% 70% at 30% 12%, rgba(255, 255, 255, .9), transparent 60%),
    rgba(255, 255, 255, .72);
  -webkit-backdrop-filter: blur(24px) saturate(1.7);
  backdrop-filter: blur(24px) saturate(1.7);
  box-shadow: 0 18px 40px -18px rgba(15, 23, 41, .5), inset 0 1px 0 rgba(255, 255, 255, .8);
  transition: transform .16s ease, box-shadow .16s ease;
}
[part="launcher"][hidden] { display: none; }
[part="launcher"]:hover { transform: translateY(-1px); }
[part="launcher"]:active { transform: scale(.96); }
[part="launcher"]:focus-visible { outline: 2px solid var(--_accent); outline-offset: 3px; }

[part="icon"] { width: 23px; height: 23px; }

[part="badge"] {
  position: absolute;
  top: 3px;
  right: 3px;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--_accent);
  border: 2px solid rgba(255, 255, 255, .95);
  animation: wandkit-dock-pulse 1.8s ease-in-out infinite;
}
[part="badge"][hidden] { display: none; }
[part="launcher"][data-status="awaiting_confirmation"] [part="badge"] {
  background: var(--wandkit-danger, #ff3b30);
}

/* 窄屏上 400px 的浮层等于半个屏幕，贴边留一点缝比强行居中更像原生。 */
@media (max-width: 640px) {
  [part="frame"] {
    right: 12px;
    left: 12px;
    width: auto;
    max-width: none;
    bottom: calc(var(--_inset) + var(--_size) + 12px);
    height: auto;
    top: 12px;
  }
}

@keyframes wandkit-dock-in {
  from { opacity: 0; transform: translateY(10px) scale(.985); }
}
@keyframes wandkit-dock-pulse { 50% { opacity: .35 } }
@media (prefers-reduced-motion: reduce) {
  [part="frame"] { animation: none; }
  [part="launcher"] { transition: none; }
  [part="badge"] { animation: none !important; }
}
`

const SVG_NS = 'http://www.w3.org/2000/svg'

/** 对话气泡。静态图形，用 DOM 构造而不是 innerHTML，与包内其它组件一致。 */
const BUBBLE_PATH =
  'M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v7a2.5 2.5 0 0 1-2.5 2.5H10l-4.2 3.5A1 1 0 0 1 4 17.7Z'

export class WandkitChatDock extends HTMLElement {
  private readonly root: ShadowRoot
  private frame!: HTMLElement
  private launcher!: HTMLButtonElement
  private badge!: HTMLElement
  private isOpen = false
  private status: ChatStatus = 'idle'
  /** 上一次强制展开对应的事由，用于只在「换了一件事」时再弹。 */
  private lastAttention: string | null = null
  private built = false

  constructor() {
    super()
    this.root = this.attachShadow({ mode: 'open' })
  }

  /** 展开与收起。写它等于用户点了图标，因此同样会派发 `dock-toggle`。 */
  set open(value: boolean) {
    const next = Boolean(value)
    if (next === this.isOpen) return
    this.isOpen = next
    this.build()
    this.render()
    this.dispatchEvent(new CustomEvent('dock-toggle', {
      bubbles: true, composed: true, detail: { open: next }
    }))
  }

  get open(): boolean {
    return this.isOpen
  }

  /**
   * 会话状态。壳只从里面取两件事：现在忙不忙，以及**有没有事等着人做决定**。
   *
   * 后者会强制展开。收起是用户的意愿，这里却要违反它，因为待确认意味着某个真实写请求正
   * 挂在半空：用户看不到卡片就不会点，业务侧只表现为按钮一直转圈，而治理就此静默失效。
   * 出错同理——错误藏在收起的壳里，用户只会觉得助手坏了。
   *
   * 只在事由**变化时**弹一次：同一个待确认项被用户手动收起后不再纠缠，否则壳会和用户抢
   * 这个按钮。
   */
  set state(value: ChatState) {
    this.status = value.status
    this.build()

    const attention = value.confirmation
      ? `confirmation:${value.confirmation.confirmationId}`
      : value.error
        ? `error:${value.error}`
        : null

    if (attention !== null && attention !== this.lastAttention) this.open = true
    this.lastAttention = attention

    this.render()
  }

  connectedCallback(): void {
    this.build()
    this.render()
    document.addEventListener('keydown', this.onKeydown)
  }

  disconnectedCallback(): void {
    document.removeEventListener('keydown', this.onKeydown)
  }

  /** Esc 收起。浮层盖住了应用的一角，键盘上得有一条不用找按钮的退路。 */
  private readonly onKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && this.isOpen) this.open = false
  }

  private build(): void {
    if (this.built) return
    this.built = true

    const style = document.createElement('style')
    style.textContent = STYLE

    this.frame = document.createElement('div')
    this.frame.setAttribute('part', 'frame')
    this.frame.appendChild(document.createElement('slot'))

    this.launcher = document.createElement('button')
    this.launcher.setAttribute('part', 'launcher')
    this.launcher.type = 'button'
    this.launcher.addEventListener('click', () => { this.open = true })

    // 内容自己的关闭按钮（面板标题栏上那个）冒泡到这里。这样面板不必知道自己被装在
    // 什么里面，换成接入方自己的组件也只要照样派发一个 `close`。
    this.addEventListener('close', () => { this.open = false })

    this.badge = document.createElement('span')
    this.badge.setAttribute('part', 'badge')

    this.launcher.append(this.buildIcon(), this.badge)
    this.root.append(style, this.frame, this.launcher)
  }

  private buildIcon(): SVGElement {
    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('part', 'icon')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '1.7')
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('stroke-linejoin', 'round')
    svg.setAttribute('aria-hidden', 'true')

    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', BUBBLE_PATH)
    svg.appendChild(path)

    return svg
  }

  private render(): void {
    if (!this.built) return

    this.frame.hidden = !this.isOpen
    this.toggleAttribute('open', this.isOpen)

    // 展开后图标让位给面板标题栏上的关闭按钮。留着它只会被面板压住露出一角，
    // 那种半遮的按钮看起来就像点不了的——真实接入里正是这样反馈回来的。
    this.launcher.hidden = this.isOpen
    this.launcher.setAttribute('aria-expanded', String(this.isOpen))
    this.launcher.setAttribute('data-status', this.status)
    this.launcher.setAttribute(
      'aria-label',
      this.isOpen ? '收起助手' : LAUNCHER_LABEL[this.status]
    )
    // 角标只在收起时有意义：展开后状态由面板标题栏说清楚，两处同时闪只是噪声。
    this.badge.hidden = this.isOpen || this.status === 'idle'
  }
}

/** 元素名。重复注册跳过，便于热更新与多次引入下保持幂等。 */
export const CHAT_DOCK_TAG = 'wandkit-dock'

if (typeof customElements !== 'undefined' && !customElements.get(CHAT_DOCK_TAG)) {
  customElements.define(CHAT_DOCK_TAG, WandkitChatDock)
}

/** 壳派发的事件载荷。宿主可据此把展开偏好记下来。 */
export interface ChatDockToggleDetail {
  open: boolean
}
