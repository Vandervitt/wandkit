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

/** 原生就可交互的**叶子**标签。它们的内部结构只是装饰，不该单独成项。 */
const SEMANTIC_LEAF_SELECTOR = 'button,a[href],input,select,textarea'

const CANDIDATE_SELECTOR = [
  SEMANTIC_LEAF_SELECTOR,
  '[role]', '[tabindex]', '[contenteditable="true"]'
].join(',')

/**
 * 语义标签之外，还要靠**渲染事实**兜住的那一类可点元素。
 *
 * 组件库大量使用无语义标签实现交互：Element UI 的下拉选项就是纯 `<li>`，既没有
 * `role` 也没有 `tabindex`，光按选择器一个都抓不到（真实浏览器实测确认）。
 *
 * `cursor: pointer` 是这里唯一可靠且框架无关的信号：
 *
 * - 它是**计算样式**，即浏览器渲染后的事实，不是类名——构建工具哈希的是类名，
 *   样式值本身不受影响；
 * - 它跨框架成立：任何 UI 库把某个东西做成可点的，都会给它 `pointer`，否则用户
 *   根本看不出那里能点；
 * - 实测区分度良好：下拉项与按钮均为 `pointer`，普通文本为 `auto`。
 *
 * 这条规则替代了早期一版基于 `.el-select` 类名的适配——那违反了「只用生产构建后
 * 存活的信息」这条原则，且换个 UI 库就失效。
 */
const CLICKABLE_CURSOR = 'pointer'

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

/** 视口外扩的默认像素数，见 {@link CaptureOptions.viewportExpansion}。 */
export const DEFAULT_VIEWPORT_EXPANSION = 100

export interface CaptureOptions {
  /**
   * 是否把 `cursor: pointer` 的元素也算作可点，缺省开启。
   *
   * 关掉会漏掉组件库用无语义标签实现的交互（下拉选项、自定义菜单项）；开着的代价是
   * 每个候选都要算一次样式。只有在明确知道页面全部使用语义标签时才值得关。
   */
  detectClickableCursor?: boolean
  /**
   * 视口过滤范围，缺省 {@link DEFAULT_VIEWPORT_EXPANSION}。
   *
   * - `-1` —— 全页面，不做视口限制
   * - `0` —— 仅当前视口内
   * - 正数 —— 视口向外扩展该像素数
   *
   * 后台列表页动辄上百个可交互元素，全量抓取会撑爆 token 预算，且屏幕外的元素当前
   * 本来也不该操作。配合 `scroll` 原语，模型「看不到就滚动再看」，与逐步重读天然契合。
   *
   * 缺省取正数而非 `0`：纯视口会把刚滚出边缘一点的元素切掉，导致模型反复来回滚动。
   */
  viewportExpansion?: number
  /**
   * 是否排除被遮挡的元素，缺省开启。
   *
   * 弹窗、抽屉、遮罩打开时，底层元素在 DOM 里依然「可见」，但用户点不到。不排除的话
   * 模型会去点它们，点在遮罩上什么也不会发生——而模型以为点成功了，进而基于错误前提
   * 继续推理。
   *
   * 对本项目尤其重要：确认卡片本身就是遮罩层，闸门弹出期间模型不该看到底层元素。
   */
  detectOcclusion?: boolean
}

/**
 * 单次抓取内的度量缓存。
 *
 * `getComputedStyle` 与 `getBoundingClientRect` 都会触发样式计算/重排，而可见性、
 * 视口、cursor 三项判定会对同一个元素反复取值。用 WeakMap 缓存一趟，大页面上是
 * 数量级的差别。缓存只活在一次抓取内，因此不会读到过期布局。
 */
class MeasureCache {
  private readonly styles = new WeakMap<Element, CSSStyleDeclaration>()
  private readonly rects = new WeakMap<Element, DOMRect>()

  constructor(private readonly view: Window | null) {}

  style(element: Element): CSSStyleDeclaration | undefined {
    if (!this.view) return undefined
    const cached = this.styles.get(element)
    if (cached) return cached
    const computed = this.view.getComputedStyle(element)
    this.styles.set(element, computed)
    return computed
  }

  rect(element: Element): DOMRect {
    const cached = this.rects.get(element)
    if (cached) return cached
    const rect = element.getBoundingClientRect()
    this.rects.set(element, rect)
    return rect
  }
}

/** 读取当前页面，同时保留元素引用。 */
export function capturePageWithElements(
  root: ParentNode = document,
  options: CaptureOptions = {}
): CaptureResult {
  const snapshotElements: SnapshotElement[] = []
  const domElements: Element[] = []
  const detectCursor = options.detectClickableCursor !== false
  const expansion = options.viewportExpansion ?? DEFAULT_VIEWPORT_EXPANSION
  const detectOcclusion = options.detectOcclusion !== false
  const candidates = detectCursor
    ? root.querySelectorAll('*')
    : root.querySelectorAll(CANDIDATE_SELECTOR)

  const doc = ownerDocumentOf(root)
  const cache = new MeasureCache(doc?.defaultView ?? null)
  // jsdom 一类环境没有布局引擎，所有盒模型度量恒为 0。此时视口与遮挡判定会把一切
  // 都判成「不可见」，因此先探测一次，无布局时整体跳过这两项。
  const layout = hasLayout(doc, cache)

  candidates.forEach(element => {
    if (!isVisible(element, cache, layout)) return
    const role = roleOf(element, detectCursor, cache)
    if (!role || !INTERACTIVE_ROLES.has(role)) return
    if (layout && !isInViewport(element, expansion, cache)) return
    if (layout && detectOcclusion && !isTopElement(element, cache)) return

    const name = accessibleName(element, cache)
    // 纯容器不收录：它自己没有名字，模型无从辨识；而它包着的那些元素会各自被收录，
    // 那才是该操作的目标。实测中侧边菜单的 `<ul>` / `<li>` 就属于这一类。
    if (!name && hasInteractiveDescendant(element, cache)) return

    const snapshot: SnapshotElement = {
      index: snapshotElements.length,
      role,
      name
    }
    const value = valueOf(element)
    if (value) snapshot.value = value
    if (isDisabled(element)) snapshot.disabled = true
    if (isChecked(element)) snapshot.checked = true
    if (isReadonly(element)) snapshot.readonly = true
    snapshotElements.push(snapshot)
    domElements.push(element)
  })

  return {
    snapshot: {
      title: doc?.title ?? '',
      url: doc?.defaultView?.location.href ?? '',
      elements: snapshotElements
    },
    elements: domElements
  }
}

function ownerDocumentOf(root: ParentNode): Document | undefined {
  if (typeof Document !== 'undefined' && root instanceof Document) return root
  return (root as Element).ownerDocument ?? undefined
}

/**
 * 探测当前环境是否有布局引擎。
 *
 * jsdom 不做布局，`getBoundingClientRect` 恒返回全 0。若不识别这种情况，视口过滤会
 * 把每个元素都判为「不在视口内」，快照直接变空——单测会全线误报。
 */
function hasLayout(doc: Document | undefined, cache: MeasureCache): boolean {
  if (!doc?.documentElement) return false
  const rect = cache.rect(doc.documentElement)
  return rect.width > 0 || rect.height > 0
}

/**
 * 元素是否落在（外扩后的）视口内。
 *
 * 用 `getClientRects()` 而非单个 `getBoundingClientRect()`：换行的行内元素会拆成
 * 多个矩形，只要任一片落进视口就算可见，用外接矩形会把这类元素误判成横跨整行。
 */
function isInViewport(
  element: Element,
  expansion: number,
  cache: MeasureCache
): boolean {
  if (expansion < 0) return true
  const view = element.ownerDocument.defaultView
  if (!view) return true
  const rects = element.getClientRects()
  const list = rects.length > 0 ? Array.from(rects) : [cache.rect(element)]
  return list.some(rect => {
    if (rect.width === 0 && rect.height === 0) return false
    return rect.bottom >= -expansion &&
      rect.top <= view.innerHeight + expansion &&
      rect.right >= -expansion &&
      rect.left <= view.innerWidth + expansion
  })
}

/**
 * 元素是否为其所在位置的最顶层元素，即用户点得到它。
 *
 * 三点采样（中心、左上偏内、右下偏内）而不是只看中心：圆角、部分遮挡、以及中心恰好
 * 压在子元素间隙上的情况，单点都会误判。任一点命中即认可。
 *
 * 命中判定包含后代与祖先两个方向：点到子元素（按钮里的 `<span>`）算命中，点到祖先
 * （元素本身透明、事件落在容器上）也算。
 */
function isTopElement(element: Element, cache: MeasureCache): boolean {
  const doc = element.ownerDocument
  const root = element.getRootNode() as Document | ShadowRoot
  const fromPoint = (root as Document).elementFromPoint?.bind(root) ??
    doc.elementFromPoint.bind(doc)
  const rect = cache.rect(element)
  if (rect.width === 0 && rect.height === 0) return false

  const inset = 1
  const points: Array<[number, number]> = [
    [rect.left + rect.width / 2, rect.top + rect.height / 2],
    [rect.left + inset, rect.top + inset],
    [rect.right - inset, rect.bottom - inset]
  ]

  return points.some(([x, y]) => {
    const hit = fromPoint(x, y)
    if (!hit) return false
    return hit === element || element.contains(hit) || hit.contains(element)
  })
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
    // 只读要明确告诉模型：它唯一能做的是点击，不要试图往里打字。
    if (element.readonly) parts.push('(readonly)')
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
  detectCursor: boolean,
  cache: MeasureCache
): string | undefined {
  const explicit = element.getAttribute('role')?.trim()
  if (explicit) return explicit

  const tag = element.tagName.toLowerCase()
  if (tag === 'button') return 'button'
  if (tag === 'a') return element.hasAttribute('href') ? 'link' : undefined
  if (tag === 'select') return 'combobox'
  if (tag === 'textarea') return 'textbox'

  if (tag === 'input') {
    const type = (element as HTMLInputElement).type.toLowerCase()
    if (type === 'checkbox') return 'checkbox'
    if (type === 'radio') return 'radio'
    if (type === 'button' || type === 'submit' || type === 'reset') return 'button'
    if (type === 'hidden') return undefined
    if (type === 'search') return 'searchbox'
    return 'textbox'
  }

  if (element.hasAttribute('contenteditable')) {
    return element.getAttribute('contenteditable') === 'true' ? 'textbox' : undefined
  }
  if (element.hasAttribute('tabindex')) return 'button'
  // 兜底：没有任何语义、但渲染成可点的元素，见 CLICKABLE_CURSOR。
  return detectCursor && isCursorClickable(element, cache) ? 'button' : undefined
}

/**
 * 该元素是否被渲染成「可点」，且它自己就是那次点击的最佳代表。
 *
 * `cursor: pointer` 会向下继承，因此一个可点的东西往往整条祖先链都命中。不去重的话
 * `<button><span>删除</span></button>` 会产出两条都叫「删除」的记录——模型无从选择，
 * 快照也会随嵌套深度膨胀。
 *
 * 三条排除规则，都只作用于「靠 cursor 兜底」这条路径，语义标签不受影响：
 */
function isCursorClickable(element: Element, cache: MeasureCache): boolean {
  if (cache.style(element)?.cursor !== CLICKABLE_CURSOR) return false
  // 1. 祖先是语义**叶子**（button / a / input 等）——那才是该点的目标，本元素只是
  //    它的内部结构（`<button>` 里的 `<span>`、`<i>` 图标）。
  //
  //    这里刻意只认叶子而不认 `[role]` / `[tabindex]` 容器：组件库大量把 `role` 挂在
  //    包装元素上（Element UI 的 `<li role="menuitem">` 里再放一个可点的标题 div），
  //    若把容器也算进来，真正可点的标题会被连带拒绝，整个菜单项就消失了。
  if (element.parentElement?.closest(SEMANTIC_LEAF_SELECTOR)) return false
  // 2. 内部含语义可交互元素——本元素只是容器，真正该点的是里面那个。
  if (element.querySelector(CANDIDATE_SELECTOR)) return false
  // 3. 还有更内层的可点元素——取最内层，它对应的点击目标更精确。
  return !Array.from(element.children).some(child =>
    cache.style(child)?.cursor === CLICKABLE_CURSOR)
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
function accessibleName(element: Element, cache?: MeasureCache): string {
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

  // 含可交互后代的元素只取**自己的直接文本**，绝不取整棵子树。
  //
  // 真实后台实测：Element UI 的 `<ul class="el-menu">` 有 104 个可交互后代，
  // 取子树文本会得到一个 236 字符、把所有菜单项名称串在一起的名字——既无法辨识，
  // 又白烧 token。真正该点的是里面各自带直接文本的菜单标题。
  const text = hasInteractiveDescendant(element, cache)
    ? directText(element)
    : element.textContent
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

/**
 * 值一律不进快照的输入类型。
 *
 * 快照会被原样发给模型（进而离开浏览器、可能被厂商留存），因此凭据绝不能出现在
 * 里面。这不是「最好别」而是硬红线：本包的核心主张之一就是 Key 与凭据不进前端
 * 链路，快照泄漏密码等于把这条主张从背面拆掉。
 *
 * 真实浏览器实测发现的问题——jsdom 夹具里没有密码框，测不出来。
 */
const SECRET_INPUT_TYPES = new Set(['password'])

/**
 * 名字看起来像凭据的字段，同样不取值。
 *
 * 覆盖那些出于「方便查看」把 `type` 写成 `text` 的密码框、验证码和令牌输入。
 * 宁可多脱敏几个字段（模型顶多少一点上下文），也不能漏掉一个真凭据。
 */
const SECRET_NAME_PATTERN =
  /pass|pwd|secret|token|credential|captcha|verif|otp|密码|口令|密钥|验证码/i

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
  if (!input.value) return undefined
  return isSecretField(input) ? '[已脱敏]' : input.value
}

/**
 * 判定一个字段是否承载凭据。
 *
 * 三个信号任一命中即脱敏：`type=password`、`autocomplete` 声明了密码语义、
 * 以及 name/id/placeholder/aria-label 里出现凭据字样。
 */
function isSecretField(input: HTMLInputElement): boolean {
  if (SECRET_INPUT_TYPES.has(input.type.toLowerCase())) return true
  if (/password/i.test(input.getAttribute('autocomplete') ?? '')) return true
  const hints = [
    input.getAttribute('name'),
    input.getAttribute('id'),
    input.getAttribute('placeholder'),
    input.getAttribute('aria-label')
  ].filter(Boolean).join(' ')
  return SECRET_NAME_PATTERN.test(hints)
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
function isVisible(
  element: Element,
  cache: MeasureCache,
  layout: boolean
): boolean {
  if (element.closest('[hidden]')) return false
  if (element.closest('[aria-hidden="true"]')) return false

  const style = cache.style(element)
  if (!style) return true
  if (style.display === 'none' || style.visibility === 'hidden') return false

  // 有布局引擎时，`offsetWidth/Height` 已经隐含了「祖先被隐藏」——祖先 display:none
  // 会让后代的盒模型整体塌成 0。比自己沿祖先链逐级取样式省得多。
  if (layout) {
    const box = element as HTMLElement
    if (box.offsetWidth !== undefined && box.offsetHeight !== undefined) {
      return box.offsetWidth > 0 || box.offsetHeight > 0
    }
  }

  // 无布局引擎（jsdom / SSR）：退回沿祖先链检查样式。
  let current: Element | null = element.parentElement
  while (current) {
    const parentStyle = cache.style(current)
    if (parentStyle?.display === 'none' || parentStyle?.visibility === 'hidden') {
      return false
    }
    current = current.parentElement
  }
  return true
}

/**
 * 元素内部是否还有别的可交互元素——即它是个「容器」而非「目标」。
 *
 * 必须同时认语义后代与 cursor 可点后代：组件库常把 `role` 挂在包装元素上、真正可点的
 * 是里面一个无语义的 div（Element UI 的菜单项就是这样）。只查语义选择器的话，包装
 * 元素会被当成目标，与里面那个 div 各产出一条同名记录。
 *
 * 先查选择器（命中即返回，快），查不到再扫 cursor（慢），因此常见情况下开销很低。
 */
function hasInteractiveDescendant(element: Element, cache?: MeasureCache): boolean {
  // 语义叶子永远是「目标」而非「容器」：`<button>` 里的 `<span>`、`<i>` 只是装饰，
  // 它的名字理应取整段文本。不豁免的话按钮会因为内部有可点子元素而被整个跳过。
  if (element.matches(SEMANTIC_LEAF_SELECTOR)) return false
  if (element.querySelector(CANDIDATE_SELECTOR)) return true
  if (!cache) return false
  return Array.from(element.querySelectorAll('*'))
    .some(child => cache.style(child)?.cursor === CLICKABLE_CURSOR)
}

/** 只取元素自己的直接文本子节点，不含任何后代的文本。 */
function directText(element: Element): string {
  return Array.from(element.childNodes)
    .filter(node => node.nodeType === 3)
    .map(node => node.textContent ?? '')
    .join('')
}

/** 折叠连续空白。多行文本原样进快照会迅速把 token 预算吃光。 */
function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}
