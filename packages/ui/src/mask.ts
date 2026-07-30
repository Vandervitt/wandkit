/** 遮罩的可选行为。 */
export interface InteractionMaskOptions {
  /**
   * 当前正在做什么。展示给用户，也回答「页面为什么点不动了」。
   *
   * 按纯文本渲染——它常常来自模型输出，与页面业务数据一样不可信。
   */
  label?: string
  /**
   * 透明模式：拦截交互但不遮挡视线。
   *
   * 用户需要看清 Agent 在页面上做了什么；整块灰罩会把自动化过程变成黑箱，
   * 而看不见的自动化恰恰是最难被信任的。
   */
  transparent?: boolean
  /** 挂载点，默认 `document.body`。 */
  container?: HTMLElement
}

/**
 * 遮罩层级。
 *
 * 刻意比 32 位有符号上限低一档，**给治理界面留出位置**——确认卡片必须排在遮罩
 * 之上，否则用户点不到自己的闸门，Run 就此卡在等待确认（真实接入实测过）。
 *
 * 除此之外仍要压过宿主的一切弹层。
 *
 * 必须压过宿主的一切弹层——Element UI、Ant Design 这类组件库的 z-index 常年在
 * 2000~3000,而老后台里手写 9999 的也不少。只要有一个弹层盖在遮罩之上，用户就能
 * 点到下面的业务按钮，「窗口内的请求必然来自 Agent」这个前提当场失效。
 */
export const MASK_LAYER = 2147483646

/** 被吞掉的事件。覆盖指针、键盘与触摸三条输入路径。 */
const BLOCKED_EVENTS = [
  'click', 'dblclick', 'mousedown', 'mouseup', 'contextmenu',
  'keydown', 'keyup', 'keypress',
  'touchstart', 'touchend', 'wheel'
] as const

const STYLE = `
:host { display: contents; }
[part="overlay"] {
  position: fixed;
  inset: 0;
  z-index: ${MASK_LAYER};
  display: flex;
  align-items: flex-end;
  justify-content: center;
  padding-bottom: 48px;
  background: var(--tal-mask-bg, rgba(15, 18, 22, .28));
  cursor: progress;
  font-family: var(--tal-font, system-ui, -apple-system, "PingFang SC", sans-serif);
}
[part="overlay"][data-transparent="true"] { background: transparent; }
[part="label"] {
  max-width: 70vw;
  padding: 8px 16px;
  border-radius: 999px;
  background: var(--tal-mask-label-bg, rgba(15, 18, 22, .82));
  color: var(--tal-mask-label-fg, #fff);
  font-size: 13px;
  line-height: 1.5;
  box-shadow: 0 2px 12px rgba(0, 0, 0, .18);
  white-space: pre-wrap;
  word-break: break-all;
}
[part="label"]:empty { display: none; }
`

/** 元素名。重复注册跳过，便于热更新与多次引入下保持幂等。 */
export const MASK_TAG = 'toolairlock-mask'

/** 遮罩的自定义元素外壳。生命周期由 {@link InteractionMask} 管理。 */
export class ToolairlockMaskElement extends HTMLElement {
  readonly root: ShadowRoot

  constructor() {
    super()
    this.root = this.attachShadow({ mode: 'open' })
  }
}

if (typeof customElements !== 'undefined' && !customElements.get(MASK_TAG)) {
  customElements.define(MASK_TAG, ToolairlockMaskElement)
}

/**
 * 交互遮罩：Agent 动作期间把用户挡在外面。
 *
 * 它看起来只是个加载罩，实际承担的是**归属判定**这件事。API 层拦截要回答「这个请求
 * 是 Agent 发的还是用户自己点的」，通用做法是链路追踪（点击时发号、请求时染色），但
 * 跨异步边界传递上下文在浏览器里没有可靠解法，只能靠时间窗口一类的妥协。
 *
 * 换个角度问题就消失了：**动作期间不让用户操作**，窗口内的请求自然只可能来自 Agent。
 * 用排除法代替追踪，既准确又简单，也是 RPA 领域的通行做法。
 *
 * 因此它不是装饰，关掉它等于让整个方案失去前提。
 *
 * ```ts
 * const mask = new InteractionMask({ label: '正在执行：删除用户' })
 * mask.arm()
 * try { await runAgentAction() } finally { mask.disarm() }
 * ```
 */
export class InteractionMask {
  private readonly options: InteractionMaskOptions
  private element: ToolairlockMaskElement | null = null
  private labelNode: HTMLElement | null = null
  private label: string

  constructor(options: InteractionMaskOptions = {}) {
    this.options = options
    this.label = options.label ?? ''
  }

  /** 当前是否处于武装状态。 */
  get armed(): boolean {
    return this.element !== null
  }

  /**
   * 挂载遮罩，开始拦截用户输入。
   *
   * 重复调用是空操作——Agent 的多步动作常常各自 arm 一次，叠出第二层遮罩只会让
   * disarm 的配对关系变得难以推理。
   */
  arm(): void {
    if (this.element) return

    const host = document.createElement(MASK_TAG) as ToolairlockMaskElement
    const style = document.createElement('style')
    style.textContent = STYLE

    const overlay = document.createElement('div')
    overlay.setAttribute('part', 'overlay')
    overlay.setAttribute('role', 'alert')
    overlay.setAttribute('aria-busy', 'true')
    if (this.options.transparent) overlay.setAttribute('data-transparent', 'true')
    // 同时写进内联样式：宿主若因 CSP 丢掉了 <style>，拦截能力也不能跟着丢。
    overlay.style.position = 'fixed'
    overlay.style.inset = '0'
    overlay.style.zIndex = String(MASK_LAYER)

    const label = document.createElement('div')
    label.setAttribute('part', 'label')
    label.textContent = this.label
    overlay.appendChild(label)

    // 捕获阶段拦截并阻止继续传播：业务代码大量使用 document 级事件委托，
    // 只在冒泡阶段拦是拦不住的。
    BLOCKED_EVENTS.forEach(type => {
      overlay.addEventListener(type, swallow, { capture: true })
    })

    host.root.append(style, overlay)
    ;(this.options.container ?? document.body).appendChild(host)

    this.element = host
    this.labelNode = label
  }

  /** 更新状态文案。未武装时只记住，下次 arm 时生效。 */
  setLabel(label: string): void {
    this.label = label
    if (this.labelNode) this.labelNode.textContent = label
  }

  /**
   * 移除遮罩，把页面交还给用户。
   *
   * 必须放在 `finally` 里：动作抛异常却没解除遮罩，页面就永久点不动了——比不做遮罩
   * 严重得多。
   */
  disarm(): void {
    if (!this.element) return
    this.element.remove()
    this.element = null
    this.labelNode = null
  }
}

/** 吞掉事件：既不让它继续传播，也不让默认行为发生。 */
function swallow(event: Event): void {
  event.preventDefault()
  event.stopPropagation()
  event.stopImmediatePropagation()
}
