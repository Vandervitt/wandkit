/**
 * 页面快照：把当前 DOM 压成模型读得懂的、带索引的可交互元素清单。
 *
 * **不维护任何目录，每次调用都重新读取。** SPA 的可操作项随数据、权限和组件状态
 * 变化，任何缓存下来的能力目录都会立刻过时；而逐步重读永远是当前真相，也天然只
 * 反映当前用户实际看得见的东西。
 *
 * **只取生产构建后仍然存在的信息**：`role`、可访问名、原生属性、文本。CSS class
 * 会被压成 `_dangerButton_wukff_1`，组件名直接蒸发（已实测），因此一概不用。这与
 * 本仓库 E2E 选择器规则同源：优先可访问性语义，禁止依赖易变 class。
 */

/** 快照里的一个可交互元素。 */
export interface SnapshotElement {
  /** 动作原语回指用的下标，从 0 连续递增。 */
  index: number
  /** 可访问性角色，如 `button` / `link` / `textbox`。 */
  role: string
  /** 可访问名。模型据此判断这个元素是干什么的。 */
  name: string
  /** 当前值（输入类元素）。 */
  value?: string
  disabled?: boolean
  checked?: boolean
  /** 只读：模型据此不再尝试往里打字。 */
  readonly?: boolean
}

export interface PageSnapshot {
  title: string
  url: string
  elements: SnapshotElement[]
}

/** 参与快照的角色。不在此列的元素即使可聚焦也不收录，避免快照被容器噪声淹没。 */
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'combobox', 'checkbox', 'radio',
  'switch', 'tab', 'menuitem', 'option', 'slider', 'searchbox'
])

const CANDIDATE_SELECTOR = [
  'button', 'a[href]', 'input', 'select', 'textarea',
  '[role]', '[tabindex]', '[contenteditable="true"]'
].join(',')

/**
 * 「这个 readonly 输入框其实是个下拉选择器」的识别线索。
 *
 * 需要它是因为：组件库普遍用 `<input readonly>` 加浮层来实现下拉，而**不提供任何
 * ARIA**。Element UI 的 `<el-select>` 就渲染成一个 readonly 的 text input，光看
 * HTML 语义无法与「只读展示字段」区分开——两者的正确操作完全相反（一个要点开选，
 * 一个碰都不该碰）。
 *
 * 这里是本包唯一依赖 CSS class 的地方，因此要说清它为什么可以：组件库的类名
 * （`el-select`）是**公开的主题化接口**，随库版本走，不会被构建工具哈希；被哈希的是
 * CSS Modules / scoped 样式那类应用自有类名。二者性质不同。
 *
 * 仍然做成可覆盖的：换 UI 库时补一条选择器即可，不必改本包。
 */
export const DEFAULT_COMBOBOX_ANCESTORS = [
  '[role="combobox"]',
  '.el-select',
  '.el-date-editor',
  '.el-cascader',
  '.el-time-select',
  '.ant-select',
  '.ant-picker'
]

/**
 * 快照，外加与 `elements` 下标一一对应的真实元素引用。
 *
 * 两者必须在**同一次遍历**里产出：分两次筛选的话，任何一侧的条件改动都会让下标
 * 悄悄错位，而错位的后果是动作落到别的元素上——这是最难查也最危险的一类 bug。
 */
export interface CaptureResult {
  snapshot: PageSnapshot
  elements: Element[]
}

export interface CaptureOptions {
  /** 覆盖下拉选择器的识别线索，见 {@link DEFAULT_COMBOBOX_ANCESTORS}。 */
  comboboxAncestors?: readonly string[]
}

/** 读取当前页面，同时保留元素引用。 */
export function capturePageWithElements(
  root: ParentNode = document,
  options: CaptureOptions = {}
): CaptureResult {
  const snapshotElements: SnapshotElement[] = []
  const domElements: Element[] = []
  const comboboxAncestors = options.comboboxAncestors ?? DEFAULT_COMBOBOX_ANCESTORS

  root.querySelectorAll(CANDIDATE_SELECTOR).forEach(element => {
    if (!isVisible(element)) return
    const role = roleOf(element, comboboxAncestors)
    if (!role || !INTERACTIVE_ROLES.has(role)) return

    const snapshot: SnapshotElement = {
      index: snapshotElements.length,
      role,
      name: accessibleName(element)
    }
    const value = valueOf(element)
    if (value) snapshot.value = value
    if (isDisabled(element)) snapshot.disabled = true
    if (isChecked(element)) snapshot.checked = true
    if (role !== 'combobox' && isReadonly(element)) snapshot.readonly = true
    snapshotElements.push(snapshot)
    domElements.push(element)
  })

  return {
    snapshot: {
      title: typeof document === 'undefined' ? '' : document.title,
      url: typeof location === 'undefined' ? '' : location.href,
      elements: snapshotElements
    },
    elements: domElements
  }
}

/** 读取当前页面。 */
export function capturePage(
  root: ParentNode = document,
  options: CaptureOptions = {}
): PageSnapshot {
  return capturePageWithElements(root, options).snapshot
}

/**
 * 渲染成交给模型的文本。
 *
 * 一行一个元素，索引在最前——模型选中后回传的就是这个下标，因此它必须显眼且稳定。
 */
export function formatSnapshot(snapshot: PageSnapshot): string {
  if (snapshot.elements.length === 0) return '(当前页面没有可交互元素)'
  return snapshot.elements.map(element => {
    const parts = [`[${element.index}]`, element.role]
    if (element.name) parts.push(element.name)
    if (element.value) parts.push(`= "${element.value}"`)
    if (element.checked) parts.push('(checked)')
    if (element.disabled) parts.push('(disabled)')
    return parts.join(' ')
  }).join('\n')
}

/**
 * 判定可访问性角色。
 *
 * 显式 `role` 优先——组件库常用 `<div role="button">` 实现按钮，只看标签名会整片漏掉。
 */
function roleOf(
  element: Element,
  comboboxAncestors: readonly string[]
): string | undefined {
  const explicit = element.getAttribute('role')?.trim()
  if (explicit) return explicit

  const tag = element.tagName.toLowerCase()
  if (tag === 'button') return 'button'
  if (tag === 'a') return element.hasAttribute('href') ? 'link' : undefined
  if (tag === 'select') return 'combobox'
  if (tag === 'textarea') return 'textbox'
  if (tag !== 'input') return undefined

  const type = (element as HTMLInputElement).type.toLowerCase()
  if (type === 'checkbox') return 'checkbox'
  if (type === 'radio') return 'radio'
  if (type === 'button' || type === 'submit' || type === 'reset') return 'button'
  if (type === 'hidden') return undefined
  // readonly 的输入框若被下拉容器包着，它其实是选择器的显示部分（Element UI 的
  // el-select 就长这样）。判成 textbox 会让模型去打字，而那在这类组件上完全无效。
  if (isReadonly(element) && element.closest(comboboxAncestors.join(','))) {
    return 'combobox'
  }
  if (type === 'search') return 'searchbox'
  return 'textbox'
}

function isReadonly(element: Element): boolean {
  return (element as HTMLInputElement).readOnly === true ||
    element.getAttribute('aria-readonly') === 'true'
}

/**
 * 计算可访问名，顺序对齐 accname 规范的常用部分。
 *
 * 这是模型识别元素用途的**唯一**依据，因此每一档都不能省：真实后台里既有规规矩矩
 * 写了 `aria-label` 的，也有全靠 `<label for>` 或 placeholder 撑着的。
 */
function accessibleName(element: Element): string {
  const ariaLabel = element.getAttribute('aria-label')
  if (ariaLabel?.trim()) return collapse(ariaLabel)

  const labelledBy = element.getAttribute('aria-labelledby')
  if (labelledBy) {
    const text = labelledBy.split(/\s+/)
      .map(id => element.ownerDocument.getElementById(id)?.textContent ?? '')
      .join(' ')
    if (text.trim()) return collapse(text)
  }

  const fromLabel = labelText(element)
  if (fromLabel) return fromLabel

  const tag = element.tagName.toLowerCase()
  if (tag === 'input') {
    const input = element as HTMLInputElement
    const type = input.type.toLowerCase()
    // 按钮类 input 的可见文字就是 value，与文本框的「当前内容」语义完全不同。
    if ((type === 'button' || type === 'submit' || type === 'reset') && input.value) {
      return collapse(input.value)
    }
  }
  if (tag === 'img') {
    const alt = element.getAttribute('alt')
    if (alt?.trim()) return collapse(alt)
  }

  const text = element.textContent
  if (text?.trim()) return collapse(text)

  const placeholder = element.getAttribute('placeholder')
  if (placeholder?.trim()) return collapse(placeholder)

  const title = element.getAttribute('title')
  return title?.trim() ? collapse(title) : ''
}

/** `<label for>` 与包裹式 `<label>` 两种写法都要认。 */
function labelText(element: Element): string {
  const id = element.getAttribute('id')
  if (id) {
    const escaped = cssEscape(id)
    const explicit = element.ownerDocument.querySelector(`label[for="${escaped}"]`)
    if (explicit?.textContent?.trim()) return collapse(explicit.textContent)
  }
  const wrapping = element.closest('label')
  if (!wrapping) return ''
  // 去掉控件自身的文本，只留标签文字（包裹式 label 常写成「手机号<input>」）。
  const clone = wrapping.cloneNode(true) as HTMLElement
  clone.querySelectorAll('input,select,textarea,button').forEach(node => node.remove())
  return clone.textContent?.trim() ? collapse(clone.textContent) : ''
}

function cssEscape(value: string): string {
  const escape = (globalThis as { CSS?: { escape?(v: string): string } }).CSS?.escape
  return escape ? escape(value) : value.replace(/["\\]/g, '\\$&')
}

function valueOf(element: Element): string | undefined {
  const tag = element.tagName.toLowerCase()
  if (tag === 'select') return (element as HTMLSelectElement).value || undefined
  if (tag === 'textarea') return (element as HTMLTextAreaElement).value || undefined
  if (tag !== 'input') return undefined
  const input = element as HTMLInputElement
  const type = input.type.toLowerCase()
  // 按钮的 value 是它的标签文字，已进 name，再放一次就是噪声。
  if (type === 'button' || type === 'submit' || type === 'reset') return undefined
  if (type === 'checkbox' || type === 'radio') return undefined
  return input.value || undefined
}

function isDisabled(element: Element): boolean {
  return (element as HTMLInputElement).disabled === true ||
    element.getAttribute('aria-disabled') === 'true'
}

function isChecked(element: Element): boolean {
  return (element as HTMLInputElement).checked === true ||
    element.getAttribute('aria-checked') === 'true'
}

/**
 * 可见性判定。
 *
 * 沿祖先链逐级检查而不是只看自身：整块面板被 `display:none` 折叠时，里面的按钮
 * 各自的计算样式仍是可见的，只看自身会把一屏根本点不到的元素塞进快照。
 */
function isVisible(element: Element): boolean {
  if (element.closest('[hidden]')) return false
  if (element.closest('[aria-hidden="true"]')) return false

  const view = element.ownerDocument.defaultView
  if (!view) return true

  let current: Element | null = element
  while (current) {
    const style = view.getComputedStyle(current)
    if (style.display === 'none' || style.visibility === 'hidden') return false
    current = current.parentElement
  }
  return true
}

/** 折叠连续空白。多行文本原样进快照会迅速把 token 预算吃光。 */
function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}
