/** 确认卡片上的一条事实。与核心包的 `ConfirmationRow` 同形。 */
export interface ConfirmCardRow {
  label: string
  value: string
}

/**
 * 即将发出的真实请求。
 *
 * 这是卡片上唯一不可能撒谎的部分：业务语义那几行由映射逻辑或模型产出，都可能过时或
 * 出错，而 method + url + body 就是下一刻要打到后端的东西本身。
 */
export interface ConfirmCardRawRequest {
  method: string
  url: string
  body?: unknown
}

/** 渲染一张确认卡片所需的全部数据。 */
export interface ConfirmCardData {
  /** 批准/拒绝事件会原样带回它，宿主据此定位是哪一次确认。 */
  confirmationId: string
  title: string
  rows: ConfirmCardRow[]
  impact?: string
  risk: 'write' | 'destructive'
  /** 有则渲染原始请求区块；破坏性操作默认展开。 */
  rawRequest?: ConfirmCardRawRequest
}

/**
 * 卡片的外观契约。
 *
 * 宿主通过 `::part()` 和 CSS 变量定制样式，但**改不掉结构**——原始请求区块、双按钮、
 * 危险标识都没有关闭开关。这是刻意的：这张卡片是治理层唯一面向人的界面，允许接入方
 * 少展示一部分，等于允许他们静默地把治理关掉。
 *
 * 视觉基调是**亮色液态玻璃**：半透明磨砂层 + 大圆角 + 分层阴影。玻璃是有意的——卡片
 * 叠在业务页面之上，透出下面的内容能让人看清「我正在为哪个界面上的动作放行」，而不是
 * 面对一个凭空出现的对话框。
 *
 * 可用的 part：`card` `risk` `title` `rows` `impact` `raw` `actions` `approve` `reject`
 * 可用的变量：`--tal-fg` `--tal-bg` `--tal-border` `--tal-danger` `--tal-accent`
 *   `--tal-dim` `--tal-radius` `--tal-font` `--tal-mono`
 */
const STYLE = `
:host { display: block; }
[part="card"] {
  --_dim: var(--tal-dim, #64748b);
  --_accent: var(--tal-accent, #0a84ff);
  --_danger: var(--tal-danger, #ff3b30);
  font-family: var(--tal-font, system-ui, -apple-system, "PingFang SC", sans-serif);
  color: var(--tal-fg, #0f1729);
  background: var(--tal-bg, rgba(255, 255, 255, .74));
  -webkit-backdrop-filter: blur(28px) saturate(1.7);
  backdrop-filter: blur(28px) saturate(1.7);
  border: 1px solid var(--tal-border, rgba(255, 255, 255, .95));
  border-radius: var(--tal-radius, 22px);
  box-shadow: 0 26px 56px -28px rgba(15, 23, 41, .32), 0 3px 12px -8px rgba(15, 23, 41, .18);
  padding: 15px 18px 18px;
  line-height: 1.6;
  font-size: 14px;
  letter-spacing: -.01em;
}
[part="card"][data-risk="destructive"] {
  box-shadow: 0 26px 56px -26px rgba(255, 59, 48, .42), 0 3px 12px -8px rgba(15, 23, 41, .18);
}
[part="risk"] {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 11px; border-radius: 999px;
  font-size: 11.5px; font-weight: 600; letter-spacing: 0;
  background: rgba(245, 158, 11, .16); color: #8a5209;
}
[part="card"][data-risk="destructive"] [part="risk"] {
  background: rgba(255, 59, 48, .13); color: #c0271d;
}
[part="title"] {
  margin: 12px 0 14px; font-size: 19px; font-weight: 620; letter-spacing: -.026em;
}
[part="rows"] { margin: 0 0 14px; padding: 0; list-style: none; font-size: 13.5px; }
[part="rows"] li { display: flex; gap: 14px; padding: 6px 0; }
[part="rows"] li + li { border-top: 1px solid rgba(15, 23, 41, .09); }
[part="rows"] .k { flex: 0 0 auto; min-width: 4.5em; color: var(--_dim); font-size: 12.5px; }
[part="rows"] .v { flex: 1 1 auto; word-break: break-all; }
[part="impact"] {
  margin: 0 0 14px; padding: 10px 13px; border-radius: 13px; font-size: 13px;
  background: rgba(245, 158, 11, .13); color: #7c4a08;
}
[part="card"][data-risk="destructive"] [part="impact"] {
  background: rgba(255, 59, 48, .1); color: #a92018;
}
[part="raw"] { margin: 0 0 16px; }
[part="raw"] summary {
  cursor: pointer; user-select: none; color: var(--_dim); font-size: 12.5px;
  list-style: none; display: flex; align-items: center; gap: 6px;
}
[part="raw"] summary::-webkit-details-marker { display: none; }
[part="raw"] summary::before {
  content: ""; width: 0; height: 0;
  border: 4px solid transparent; border-left-color: currentColor;
  transform: translateX(1px); transition: transform .15s ease;
}
[part="raw"][open] summary::before { transform: rotate(90deg) translateY(1px); }
[part="raw"] pre {
  margin: 7px 0 0; padding: 11px 13px; overflow-x: auto;
  background: rgba(15, 23, 41, .055); border-radius: 13px; color: #3c4a60;
  font-family: var(--tal-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11.5px; line-height: 1.6; white-space: pre-wrap; word-break: break-all;
}
[part="actions"] { display: flex; gap: 10px; }
[part="actions"] button {
  flex: 1 1 0; padding: 11px 14px; font: inherit; font-size: 14px; font-weight: 500;
  border-radius: 999px; cursor: pointer;
  border: 1px solid rgba(15, 23, 41, .12); background: rgba(255, 255, 255, .85); color: inherit;
}
/* 权重必须高过上一条 actions button 规则，否则 background 被压回白色，
   主按钮看不出是主按钮（实测踩到过）。 */
[part="actions"] [part="approve"] {
  flex: 1.35 1 0; border-color: transparent; color: #fff;
  background: linear-gradient(#3d9bff, #0a7ff0);
  box-shadow: 0 10px 22px -12px rgba(10, 132, 255, .9), inset 0 1px 0 rgba(255, 255, 255, .38);
}
[part="card"][data-risk="destructive"] [part="approve"] {
  background: linear-gradient(#ff5c52, #f5271b);
  box-shadow: 0 10px 22px -12px rgba(255, 59, 48, .95), inset 0 1px 0 rgba(255, 255, 255, .4);
}
[part="actions"] button:disabled { opacity: .5; cursor: default; box-shadow: none; }
`

/** 破坏性操作的按钮文案与写操作不同：让人看清自己批准的是什么类别的动作。 */
const APPROVE_LABEL: Record<ConfirmCardData['risk'], string> = {
  write: '确认执行',
  destructive: '确认删除'
}

/**
 * 危险等级的文字标识。
 *
 * 刻意做成**真实文本**而不是 CSS 的 `::before content`：后者能被宿主用
 * `::part(title)` 之类的规则覆盖掉，而危险标识没有关闭开关。
 */
const RISK_LABEL: Record<ConfirmCardData['risk'], string> = {
  write: '写操作',
  destructive: '⚠ 破坏性操作'
}

/**
 * 序列化 body 供展示。
 *
 * 不可序列化的内容（循环引用、FormData）退回到字符串形式而不是抛错——卡片弹不出来
 * 会让整个确认流程卡死，而那意味着一个危险操作既没被批准也没被拒绝。
 */
function formatBody(body: unknown): string {
  if (body === undefined) return ''
  if (typeof body === 'string') return body
  try {
    return JSON.stringify(body, null, 2)
  } catch (_error) {
    return String(body)
  }
}

/**
 * 确认卡片，原生自定义元素。
 *
 * 全部文本通过 `textContent` 写入，绝不用 `innerHTML`：`rows` 里的取值来自页面业务
 * 数据（客户名、备注），攻击者能通过普通产品表单往里种标记。用富文本方式渲染，就是
 * 在治理层自己的界面上开了一个存储型 XSS——而这个界面恰恰是权限最高的那个。
 *
 * 用法：
 * ```ts
 * const card = document.createElement('toolairlock-confirm')
 * card.data = { confirmationId, title, rows, risk, rawRequest }
 * card.addEventListener('approve', e => runtime.confirm(e.detail.confirmationId))
 * card.addEventListener('reject', e => runtime.cancel(e.detail.confirmationId))
 * container.appendChild(card)
 * ```
 */
export class ToolairlockConfirmCard extends HTMLElement {
  private readonly root: ShadowRoot
  private state: ConfirmCardData | null = null
  /** 一次交互只允许产生一个决定，见 {@link decide}。 */
  private settled = false

  constructor() {
    super()
    this.root = this.attachShadow({ mode: 'open' })
  }

  /** 设置数据即触发重绘。重设会解除锁定，因为那是一张新卡片。 */
  set data(value: ConfirmCardData | null) {
    this.state = value
    this.settled = false
    this.render()
  }

  get data(): ConfirmCardData | null {
    return this.state
  }

  connectedCallback(): void {
    if (this.state) this.render()
  }

  private render(): void {
    this.root.replaceChildren()
    const data = this.state
    if (!data) return

    const style = document.createElement('style')
    style.textContent = STYLE

    const card = document.createElement('div')
    card.setAttribute('part', 'card')
    card.setAttribute('data-risk', data.risk)
    card.setAttribute('role', 'alertdialog')
    card.setAttribute('aria-label', data.title)

    const risk = document.createElement('span')
    risk.setAttribute('part', 'risk')
    risk.textContent = RISK_LABEL[data.risk]
    card.appendChild(risk)

    const title = document.createElement('h3')
    title.setAttribute('part', 'title')
    title.textContent = data.title
    card.appendChild(title)

    if (data.rows.length > 0) {
      const list = document.createElement('ul')
      list.setAttribute('part', 'rows')
      data.rows.forEach(row => {
        const item = document.createElement('li')
        const key = document.createElement('span')
        key.className = 'k'
        key.textContent = row.label
        const value = document.createElement('span')
        value.className = 'v'
        value.textContent = row.value
        item.append(key, value)
        list.appendChild(item)
      })
      card.appendChild(list)
    }

    if (data.impact) {
      const impact = document.createElement('p')
      impact.setAttribute('part', 'impact')
      impact.textContent = data.impact
      card.appendChild(impact)
    }

    if (data.rawRequest) card.appendChild(this.renderRawRequest(data))

    card.appendChild(this.renderActions(data))
    this.root.append(style, card)
  }

  /**
   * 原始请求区块。
   *
   * 破坏性操作默认展开：删除类动作应当强迫人看一眼真正要发出去的东西，而不是只读一句
   * 被翻译过的摘要。写操作折叠，避免日常操作被噪声淹没。
   */
  private renderRawRequest(data: ConfirmCardData): HTMLDetailsElement {
    const raw = data.rawRequest as ConfirmCardRawRequest
    const details = document.createElement('details')
    details.setAttribute('part', 'raw')
    details.open = data.risk === 'destructive'

    const summary = document.createElement('summary')
    summary.textContent = '原始请求'
    details.appendChild(summary)

    const pre = document.createElement('pre')
    const body = formatBody(raw.body)
    pre.textContent = `${raw.method.toUpperCase()} ${raw.url}${body ? `\n\n${body}` : ''}`
    details.appendChild(pre)

    return details
  }

  private renderActions(data: ConfirmCardData): HTMLDivElement {
    const actions = document.createElement('div')
    actions.setAttribute('part', 'actions')

    // 拒绝排在前面：默认焦点与最短移动距离都落在更安全的那一侧。
    const reject = document.createElement('button')
    reject.setAttribute('part', 'reject')
    reject.type = 'button'
    reject.textContent = '取消'
    reject.addEventListener('click', () => this.decide('reject'))

    const approve = document.createElement('button')
    approve.setAttribute('part', 'approve')
    approve.type = 'button'
    approve.textContent = APPROVE_LABEL[data.risk]
    approve.addEventListener('click', () => this.decide('approve'))

    actions.append(reject, approve)
    return actions
  }

  /**
   * 派发一个决定，并锁死这张卡片。
   *
   * 锁定是必需的：从点击到宿主移除卡片之间隔着一次网络往返，用户很容易补第二下；
   * 更糟的是先点批准再点取消，会让 Runtime 同时收到两个互斥的决定。
   */
  private decide(kind: 'approve' | 'reject'): void {
    if (this.settled || !this.state) return
    this.settled = true
    this.root.querySelectorAll('button').forEach(button => {
      button.disabled = true
    })
    this.dispatchEvent(new CustomEvent(kind, {
      // 冒泡且穿透 Shadow 边界，宿主既可监听元素本身，也可在容器上做事件委托。
      bubbles: true,
      composed: true,
      detail: { confirmationId: this.state.confirmationId }
    }))
  }
}

/** 元素名。重复注册直接跳过，便于在热更新与多次引入下保持幂等。 */
export const CONFIRM_CARD_TAG = 'toolairlock-confirm'

if (typeof customElements !== 'undefined' && !customElements.get(CONFIRM_CARD_TAG)) {
  customElements.define(CONFIRM_CARD_TAG, ToolairlockConfirmCard)
}
