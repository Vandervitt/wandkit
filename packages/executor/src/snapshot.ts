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
  /**
   * 嵌套层级（仅在被收录的元素之间计算）。
   *
   * 表格里五行数据的五个「删除」按钮，扁平清单下完全无法区分；带上层级、格式化成
   * 缩进之后，模型才能判断该点哪一个。
   */
  depth: number
  /**
   * 白名单内的补充属性，见 {@link DISCLOSED_ATTRIBUTES}。
   *
   * 主要用途是给图标按钮一个身份——真实后台里三成元素没有任何文本。
   */
  attributes?: Record<string, string>
  /**
   * 所在行 / 卡片的文本，用于消歧同名元素。
   *
   * 表格里每行都有一个「删除」，仅凭名字模型无从选择；带上「国光科技」这样的行上下文
   * 才能定位。层级缩进解决不了这个问题——行本身通常不可交互，不会进入快照。
   */
  context?: string
  /**
   * 相对上一次抓取是新出现的。
   *
   * 由 {@link PageController} 跨抓取比对后标注，纯函数的 `capturePage` 不设置它。
   * 它直接回答「我刚才那次点击造成了什么」——下拉展开、弹窗出现全靠它辨认。
   */
  isNew?: boolean
}

/**
 * 允许进入快照的属性白名单。
 *
 * 取自 page-agent 的同名清单，但**移除了 `value`**：它由 {@link valueOf} 单独处理并
 * 做凭据脱敏，照搬会把密码明文送进模型。
 */
const DISCLOSED_ATTRIBUTES = [
  'title', 'type', 'name', 'role', 'placeholder', 'alt',
  'aria-label', 'aria-expanded', 'aria-checked', 'aria-haspopup',
  'aria-controls', 'id', 'for', 'target', 'contenteditable', 'data-date-format'
]

/** 属性值截断长度。超长的 title 与 id 会迅速吃掉预算，而辨识只需要前几个字。 */
const MAX_ATTRIBUTE_LENGTH = 20

/**
 * 页面上的一段正文。
 *
 * **为什么必须收**：只收可交互元素，Agent 就只会操作、不会阅读。真实后台实测——
 * 首页「客户数量 75　坐席数量 1766」全在 `<p>` 和 `<td>` 里，快照 15 行全是
 * button/link，一个数字都没有；问「今天有多少话单」时模型结构性失明，只能回答
 * 「找不到」。查询类请求在管理后台里占大头，读不到正文等于废掉一半用途。
 *
 * 不占用元素索引：索引是动作原语的坐标，正文不可点击，混进去只会让模型点到空处。
 */
export interface TextBlock {
  /** 归一化后的文本。 */
  text: string
  /** 与 {@link SnapshotElement.depth} 同义，用于对齐缩进。 */
  depth: number
  /**
   * 文档序上紧挨在它前面的那个已收录元素的索引，没有则为 `-1`。
   *
   * 渲染时靠它把正文插回元素之间——「这段文字属于哪一行、在哪个按钮上方」是模型
   * 理解表格和卡片的关键，单独堆一段「页面文本」会把这层关系全丢掉。
   */
  after: number
}

export interface PageSnapshot {
  title: string
  url: string
  elements: SnapshotElement[]
  /** 页面正文，见 {@link TextBlock}。 */
  texts: TextBlock[]
}

/**
 * 参与快照的角色。不在此列的元素即使可聚焦也不收录，避免快照被容器噪声淹没。
 *
 * 覆盖 WAI-ARIA 中全部「可由用户直接操作」的 widget role。**漏一个就等于整类控件
 * 对 Agent 隐形**——真实弹窗实测：数字输入框带 `role="spinbutton"`（W3C 标准），
 * 因不在此列而被整体排除，「调价」弹窗里 4 个单价框全部消失，模型根本无法填写。
 *
 * 显式 role 优先于标签推断，因此这里的遗漏无法被「它本来就是 `<input>`」兜住。
 */
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'spinbutton',
  'checkbox', 'radio', 'switch', 'slider',
  'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'option', 'treeitem', 'gridcell',
  // 本包自造：内部滚动容器。它不是 ARIA role，但模型需要知道「这里还能往下翻」。
  'scrollable'
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
 * 表示「可直接操作」的指针样式。
 *
 * 除 `pointer` 外还认拖拽类：拖动排序把手是 `move`，可拖拽面板是 `grab`/`grabbing`。
 * 它们同样是渲染出来的交互承诺——用户看到这个光标就知道这里能动。
 *
 * **刻意不含 `text`。** page-agent 把它算进去了，但普通段落大量使用 `cursor: text`，
 * 收进来会让整页文字涌入快照。可编辑区域另有 `contenteditable` 与 `<textarea>` 兜住，
 * 不必靠光标推断。
 */
const INTERACTIVE_CURSORS = new Set([CLICKABLE_CURSOR, 'move', 'grab', 'grabbing'])

/**
 * 内联事件属性。
 *
 * 老后台大量存在 `<div onclick="doSomething()">` 且不给指针样式的写法——不认它就
 * 整块功能对 Agent 隐形。
 *
 * 只能查属性：`addEventListener` 绑定的监听器在标准 DOM API 下不可枚举
 * （`getEventListeners` 仅存在于 DevTools 控制台），因此这条兜底是有缺口的，
 * 主要覆盖属性写法。
 */
const EVENT_ATTRIBUTES = [
  'onclick', 'onmousedown', 'onmouseup', 'onkeydown', 'onkeyup', 'ontouchstart'
]

/** 可滚动容器的溢出取值。 */
const SCROLLABLE_OVERFLOW = new Set(['auto', 'scroll', 'overlay'])

/**
 * 判定「确实可滚动」的最小距离。
 *
 * 亚像素与边框圆整常让 `scrollHeight` 比 `clientHeight` 大一两像素，阈值过小会把
 * 满页面的普通容器都报成可滚动。
 */
const SCROLL_THRESHOLD = 8

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
  const texts: TextBlock[] = []
  const detectCursor = options.detectClickableCursor !== false
  const expansion = options.viewportExpansion ?? DEFAULT_VIEWPORT_EXPANSION
  const detectOcclusion = options.detectOcclusion !== false
  const candidates = detectCursor
    ? root.querySelectorAll('*')
    : root.querySelectorAll(CANDIDATE_SELECTOR)

  const doc = ownerDocumentOf(root)
  const cache = new MeasureCache(doc?.defaultView ?? null)
  /**
   * 已收录且仍包含当前元素的祖先栈，用于算层级。
   *
   * 连可访问名一起存：判断一段正文是否已经被某个祖先的名字覆盖时要用到——
   * `<button><span>搜索</span></button>` 这种写法在组件库里遍地都是，不查一下就会
   * 把「搜索」既作为按钮名、又作为正文各输出一遍。
   */
  const ancestors: Array<{ element: Element, name: string }> = []
  // jsdom 一类环境没有布局引擎，所有盒模型度量恒为 0。此时视口与遮挡判定会把一切
  // 都判成「不可见」，因此先探测一次，无布局时整体跳过这两项。
  const layout = hasLayout(doc, cache)

  /**
   * 尝试把一个元素收录为可交互项。
   *
   * 抽成具名函数只为一件事：调用方需要知道**它有没有被收录**，从而决定要不要把它的
   * 正文单独收进 {@link texts}。已收录元素的文本就是它的可访问名，再收一遍是重复。
   */
  function capture(element: Element): boolean {
    const role = roleOf(element, detectCursor, cache)
    if (!role || !INTERACTIVE_ROLES.has(role)) return false
    if (layout && !isInViewport(element, expansion, cache)) return false
    if (layout && detectOcclusion && !isTopElement(element, cache)) return false

    const name = accessibleName(element, cache)
    // 包着其他可交互元素的容器不收录——真正该操作的是里面那个，不是外面这层。
    //
    // **不能只在容器无名时才丢**。名字通常正是从后代文本算出来的，于是外层拿到了和
    // 内层一模一样的名字，三层套娃全部逃逸。ant-design-vue 的单选实测：
    //
    //     <label class="ant-radio-wrapper">   cursor:pointer
    //       <span class="ant-radio">          cursor:pointer
    //         <input type="radio">
    //       상담원 개인 설정
    //
    // 三层都被收录，同一个选项在清单里出现三次、名字完全相同——模型无从选择，清单
    // 长度还膨胀三倍。
    //
    // **判据是「作者声明」还是「我们推断」**：
    //
    // - 显式 `role` 属性或原生可交互标签 —— 作者明确说了「这是一个操作目标」。
    //   可展开菜单 `<li role="menuitem">系统管理<ul>…</ul></li>` 的父项点了会展开子菜单，
    //   `<a href>` 里套 `<button>` 也是常见写法，丢掉就丢掉了这项能力。它们沿用旧规则：
    //   只在自己没有名字时才当纯容器丢弃。
    // - 仅靠 `cursor: pointer` 推断出来的 —— 上面那三层 AntD 包装正是这一类，`role`
    //   属性一个都没有。推断与已收录的后代冲突时，推断让路。
    //
    // `scrollable` 豁免：它的价值恰恰在于「是个装着东西的容器」，模型要的是「这里
    // 还能往下/往右翻」这条信息，而不是它叫什么。真实表格实测——横向可滚 570px 的
    // `.el-table__body-wrapper` 因无自身文本被这条规则丢弃，右侧列对 Agent 永远不存在。
    const declaredWidget = element.hasAttribute('role') ||
      element.matches(SEMANTIC_LEAF_SELECTOR)
    if (role !== 'scrollable' &&
      (!declaredWidget || !name) &&
      hasInteractiveDescendant(element, cache)) return false

    // `<label>` 里的装饰元素：点它等于点那个控件，而控件本身已经在清单里了。
    //
    // `cursor` 是继承属性，所以整个 label 子树都会被推断成可点——文字、图标、
    // 自定义样式层各自成项，同一个选项因此重复好几遍。上面那条规则拦不住它们：
    // 它们是控件的**兄弟**，自身并不包含任何可交互后代。
    //
    // 判据取自 HTML 标准而非某个组件库：`<label>` 的语义就是「点我等于操作里面
    // 那个控件」。声明式的操作目标（显式 role / 原生控件）不受影响。
    if (isLabelDecoration(element, declaredWidget)) return false

    const snapshot: SnapshotElement = {
      index: snapshotElements.length,
      role,
      // 滚动区通常没有自己的文本，用可滚方向作名字——模型需要的是「往哪边还能翻」，
      // 而不是它叫什么。
      name: role === 'scrollable' && !name
        ? scrollableName(element, cache)
        : name,
      depth: ancestors.length
    }
    const value = valueOf(element)
    if (value) snapshot.value = value
    if (isDisabled(element)) snapshot.disabled = true
    if (isChecked(element)) snapshot.checked = true
    if (isReadonly(element)) snapshot.readonly = true
    const attributes = disclosedAttributes(element, name)
    if (attributes) snapshot.attributes = attributes
    // 既没有名字、也没有任何可辨识属性的**非语义**元素直接丢弃。
    //
    // 真实主页实测这类元素占三成，全是折叠箭头一类的装饰性图标。模型无法指称它们，
    // 更不该去点一个自己都说不清是什么的东西——而它们仍在实打实地吃 token。
    //
    // 语义控件（input/textarea/button 等）豁免：一个没有 label 的输入框仍然是可以
    // 填写的，模型能靠位置和上下文推断它的用途；装饰性 div 则不然。
    // `scrollable` 同样豁免：它天然无名无属性（见上一条豁免的理由），而 `name` 字段
    // 已在上面填了方向名，这里查的 `name` 仍是空串。
    if (!name && !attributes && role !== 'scrollable' &&
      !element.matches(SEMANTIC_LEAF_SELECTOR)) return false
    const context = rowContext(element, name)
    if (context) snapshot.context = context
    snapshotElements.push(snapshot)
    domElements.push(element)
    ancestors.push({ element, name: snapshot.name })
    return true
  }

  candidates.forEach(element => {
    if (!isVisible(element, cache, layout)) return
    // 层级：文档序遍历下，栈里留着的都是当前元素的祖先。逐个弹出不再包含它的，
    // 剩余深度即为它在「被收录元素」这棵树里的层级。
    //
    // 必须在收录判定**之前**做：正文也要按这个深度缩进，放在 capture 内部的话，
    // 未被收录的元素拿到的是上一个分支残留的深度。
    while (ancestors.length > 0 &&
      !ancestors[ancestors.length - 1].element.contains(element)) {
      ancestors.pop()
    }
    if (capture(element)) return
    // 未被收录的元素——容器、标题、单元格——它们的直接文本就是页面正文。
    // 只取直接文本：取 textContent 会让每一层祖先都重复一遍整段内容。
    const own = collapse(directText(element))
    if (!own) return
    // 已经被某个祖先当成可访问名用掉的文本不再重复收录。
    if (ancestors.some(ancestor => ancestor.name.includes(own))) return
    // 同理，`<label>` 里的文字就是那个控件的可访问名，已经跟在控件那一行了。
    // 这里查不到它是因为 label 自己也被丢弃了，压根没进祖先栈。
    if (isLabelDecoration(element, false)) return
    // 这段文字属于某个「本该可交互、却被过滤掉」的元素时，一律不输出。
    //
    // 输出了反而更糟：模型看到「话单查询」四个字，以为那里能点，却在清单里找不到
    // 对应索引，于是去猜一个邻近的下标——真实后台实测，它因此点了「数据报表」。
    // 宁可让这一项对模型完全不存在，也不能给出一个够不到的承诺。
    if (hasFilteredInteractiveAncestor(element, detectCursor, cache)) return
    if (layout && !isInViewport(element, expansion, cache)) return
    texts.push({ text: own, depth: ancestors.length, after: snapshotElements.length - 1 })
  })

  return {
    snapshot: {
      title: doc?.title ?? '',
      url: doc?.defaultView?.location.href ?? '',
      elements: snapshotElements,
      texts
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
  const fromPoints = (root as Document).elementsFromPoint?.bind(root) ??
    doc.elementsFromPoint?.bind(doc)
  const fromPoint = (root as Document).elementFromPoint?.bind(root) ??
    doc.elementFromPoint.bind(doc)
  const rect = cache.rect(element)
  if (rect.width === 0 && rect.height === 0) return false

  const inset = 1
  const candidatePoints: Array<[number, number]> = [
    [rect.left + rect.width / 2, rect.top + rect.height / 2],
    [rect.left + inset, rect.top + inset],
    [rect.right - inset, rect.bottom - inset]
  ]

  // 只保留真正落在视口内的取样点。
  //
  // `elementsFromPoint` 的坐标一旦超出视口就恒返回空，此时「命中栈里没有它」并不
  // 说明被遮挡，只说明这个点压根测不了。而视口过滤是带外扩的（见
  // {@link CaptureOptions.viewportExpansion}），刚好滚出边缘一点的元素本就被有意
  // 收录——真实后台实测：侧边栏「话单查询」在 top=812、视口高 812，靠外扩收进来，
  // 却被这条判成遮挡而整项消失，模型只看得到它的文字、点不到它。
  const view = doc.defaultView
  const width = view?.innerWidth ?? 0
  const height = view?.innerHeight ?? 0
  const points = view
    ? candidatePoints.filter(([x, y]) => x >= 0 && y >= 0 && x < width && y < height)
    : candidatePoints
  // 整个元素都在视口之外：无从判定，按未遮挡处理。它点不到是因为要先滚动，
  // 而不是因为被盖住——两者的正确应对完全不同。
  if (points.length === 0) return true

  return points.some(([x, y]) => {
    // 先试单点：绝大多数元素本来就在栈顶，这条几乎总是命中，代价也最低。
    const hit = fromPoint(x, y)
    if (hit && (hit === element || element.contains(hit) || hit.contains(element))) {
      return true
    }
    if (!fromPoints) return false

    // 单点没命中时才取**整个命中栈**：同一个点上常有多层重叠，而它们往往都是用户
    // 点得到的。真实后台实测——Element UI 开启固定列会把整行 DOM 复制一份，主表格
    // 那份被固定列容器完全盖住，栈顶是副本层的别的按钮，只看栈顶会把整列操作按钮
    // 判成不可见。
    //
    // 「元素是否出现在栈中」既保住了本职（弹窗遮罩下的元素根本不在栈里），又不再
    // 误伤同位置重叠。放在单点之后是因为它明显更贵——真实页面实测，无条件调用会把
    // 整体耗时从 21ms 拉到 167ms。
    return fromPoints(x, y).some(stacked =>
      stacked === element || element.contains(stacked) || stacked.contains(element))
  })
}

/**
 * 单个元素是否可见。
 *
 * 供快照之外的调用方（如控制器在浮层里找选项）复用同一套判定。抓取路径不要走这里：
 * 它每次自建缓存，逐个调用在整页规模上会退化成 O(n) 次样式计算。
 */
export function isElementVisible(element: Element): boolean {
  const doc = element.ownerDocument
  const cache = new MeasureCache(doc?.defaultView ?? null)
  return isVisible(element, cache, hasLayout(doc, cache))
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
  const texts = snapshot.texts ?? []
  if (snapshot.elements.length === 0 && texts.length === 0) {
    return '(当前页面没有可交互元素)'
  }

  // 正文按文档序插回元素之间。堆成单独一段会丢掉「这段文字属于哪一行」，而那正是
  // 模型读懂表格与卡片的依据。不带索引则是刻意的：正文点不了，给了索引反而诱导点击。
  const textsAfter = new Map<number, string[]>()
  texts.forEach(block => {
    const line = `${'  '.repeat(block.depth)}${block.text}`
    const bucket = textsAfter.get(block.after)
    if (bucket) bucket.push(line)
    else textsAfter.set(block.after, [line])
  })

  const lines: string[] = [...(textsAfter.get(-1) ?? [])]
  snapshot.elements.forEach(element => {
    lines.push(formatElement(element))
    lines.push(...(textsAfter.get(element.index) ?? []))
  })
  return lines.join('\n')
}

function formatElement(element: SnapshotElement): string {
  // 缩进表达层级；`*` 表示相对上次抓取新出现，直接回答「刚才那次操作造成了什么」。
  const indent = '  '.repeat(element.depth)
  const marker = element.isNew ? '*' : ''
  const parts = [`${indent}${marker}[${element.index}]`, element.role]
  if (element.name) parts.push(element.name)
  if (element.value) parts.push(`= "${element.value}"`)
  // 行上下文用括号跟在后面：一屏五个「删除」全靠它区分。
  if (element.context) parts.push(`(${element.context})`)
  if (element.checked) parts.push('(checked)')
  // 只读要明确告诉模型：它唯一能做的是点击，不要试图往里打字。
  if (element.readonly) parts.push('(readonly)')
  if (element.disabled) parts.push('(disabled)')
  return parts.join(' ')
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
  // `tabindex` 只说明「可聚焦」，不等于「可点击」。
  //
  // 真实弹窗实测：Element UI 的 tooltip 图标（`<span class="el-tooltip" tabindex="0">`）
  // 会命中这条规则被判成 button，而它包着标签文字，于是整条表单项被当成按钮，真正
  // 该操作的输入框反被容器规则吞掉——「调价」弹窗里 6 个输入框只剩 3 个。
  //
  // 因此额外要求它渲染成可点（`cursor: pointer`）：真按钮总会有指针样式，纯提示
  // 图标不会。
  if (element.hasAttribute('tabindex')) {
    return detectCursor && isCursorClickable(element, cache) ? 'button' : undefined
  }
  // 兜底一：没有任何语义、但渲染成可交互的元素，见 INTERACTIVE_CURSORS。
  if (detectCursor && isCursorClickable(element, cache)) return 'button'
  // 兜底二：绑了内联事件却不给指针样式的元素，见 EVENT_ATTRIBUTES。
  if (hasOwnEventHandler(element)) return 'button'
  // 兜底三：内部滚动容器。它自己不是「可点」的，但模型需要知道这里还能往下翻。
  return isScrollable(element, cache) ? 'scrollable' : undefined
}

/**
 * 元素自身绑了内联事件，且祖先没有绑。
 *
 * 要求祖先没绑，是因为事件委托极其常见：`<div onclick>` 里的每个后代都会因为冒泡
 * 而「可点」，全收进来会让一次点击产出一堆候选。只认最外层那个绑定点。
 */
function hasOwnEventHandler(element: Element): boolean {
  if (!EVENT_ATTRIBUTES.some(attribute => element.hasAttribute(attribute))) return false
  let ancestor = element.parentElement
  while (ancestor) {
    if (EVENT_ATTRIBUTES.some(attribute => ancestor?.hasAttribute(attribute))) return false
    ancestor = ancestor.parentElement
  }
  return true
}

/**
 * 元素是否为可滚动容器，且内容确实溢出了。
 *
 * 只看 `overflow` 不够：绝大多数 `overflow: auto` 的容器内容并未超出，报出来纯属
 * 噪声。必须同时满足「溢出取值允许滚动」与「实际有可滚动距离」。
 *
 * 页面级 `scroll` 到不了这类容器，不识别的话下半截内容对 Agent 永远不存在。
 */
/** 用可滚方向给滚动区命名，如「可滚动区域（横向）」。 */
function scrollableName(element: Element, cache: MeasureCache): string {
  const directions: string[] = []
  if (canScrollVertically(element, cache)) directions.push('纵向')
  if (canScrollHorizontally(element, cache)) directions.push('横向')
  return `可滚动区域（${directions.join('、')}）`
}

function canScrollVertically(element: Element, cache: MeasureCache): boolean {
  const style = cache.style(element)
  if (!style || !SCROLLABLE_OVERFLOW.has(style.overflowY)) return false
  return element.scrollHeight - (element as HTMLElement).clientHeight > SCROLL_THRESHOLD
}

function canScrollHorizontally(element: Element, cache: MeasureCache): boolean {
  const style = cache.style(element)
  if (!style || !SCROLLABLE_OVERFLOW.has(style.overflowX)) return false
  return element.scrollWidth - (element as HTMLElement).clientWidth > SCROLL_THRESHOLD
}

function isScrollable(element: Element, cache: MeasureCache): boolean {
  return canScrollVertically(element, cache) || canScrollHorizontally(element, cache)
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
  const cursor = cache.style(element)?.cursor
  if (!cursor || !INTERACTIVE_CURSORS.has(cursor)) return false
  // `<label>` 永远不是可点目标，它只是某个控件的说明文字。
  //
  // 真实弹窗实测：Element UI 给必填项标签加了 `cursor: pointer`，于是标签被判成
  // button，又因为它包着输入框而触发容器规则，把真正该操作的输入框整个吞掉——
  // 一个「调价」弹窗里 6 个输入框只剩 4 个。
  if (element.tagName.toLowerCase() === 'label') return false
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
  return !Array.from(element.children).some(child => {
    const childCursor = cache.style(child)?.cursor
    return childCursor !== undefined && INTERACTIVE_CURSORS.has(childCursor)
  })
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
export function accessibleName(element: Element, cache?: MeasureCache): string {
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

  // 凭据字段到此为止：`title` 与 `value` 都可能装着密码本身（真实页面里
  // `title="admin123"` 这种写法确实存在），名字只允许来自 label / aria-label /
  // placeholder 这些必然是说明文字的来源。
  if (isSecretElement(element)) return ''

  const title = element.getAttribute('title')
  return title?.trim() ? collapse(title) : ''
}

/** 元素是否为承载凭据的输入框。 */
function isSecretElement(element: Element): boolean {
  return element.tagName.toLowerCase() === 'input' &&
    isSecretField(element as HTMLInputElement)
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
/** 表格行。它有「首格即标识」这个可利用的结构，与列表项分开处理。 */
const TABLE_ROW_SELECTOR = 'tr,[role="row"]'

/** 表格单元格。取首个即为该行的标识列。 */
const TABLE_CELL_SELECTOR = 'td,th,[role="cell"],[role="gridcell"],[role="rowheader"]'

/** 承载「一条记录」语义的容器。行上下文从这些元素上取。 */
const ROW_CONTAINER_SELECTOR = `${TABLE_ROW_SELECTOR},li,[role="listitem"],[role="option"]`

/** 行上下文的长度上限。超出说明取到的多半是整块区域而非一条记录。 */
const MAX_CONTEXT_LENGTH = 60

/**
 * 取元素所在行 / 列表项的文本，用于消歧同名元素。
 *
 * 这是表格场景的刚需：一屏五个「删除」，模型仅凭名字无法选择。层级缩进解决不了——
 * `<tr>` 通常既无 `role` 也无 `tabindex`，本身不可交互，不会进入快照。
 *
 * 只取最近的一层行容器，且长度超限即放弃：取到整块区域的文本反而会淹没有效信息。
 */
function rowContext(element: Element, name: string): string | undefined {
  const row = element.parentElement?.closest(ROW_CONTAINER_SELECTOR)
  if (!row) return undefined

  // 表格行取**首格**，而不是整行文本。
  //
  // 真实后台实测：一行有 10 个单元格、187 个字符（状态、计费、时间全在里面），整行
  // 文本既超长又淹没重点；而首格 `wzp ID: 76` 恰好就是这条记录的标识。首列即标识
  // 是后台表格的通例。
  //
  // 这条路径也不要求「叶子行」——真实操作列常带「更多」下拉，其浮层里是 `<li>`，
  // 会让整行不再是叶子，但首格依然有效。
  if (row.matches(TABLE_ROW_SELECTOR)) {
    const cell = row.querySelector(TABLE_CELL_SELECTOR)
    const text = collapse(cell?.textContent ?? '')
    if (!text || text === name) return undefined
    return text.slice(0, MAX_CONTEXT_LENGTH)
  }

  // 列表项没有「单元格」概念，只能取整体文本，因此必须是**叶子**且不超长：
  // Element UI 侧边栏的 `<li>` 包着整个子菜单，取它的文本会得到一整段菜单名拼接。
  if (row.querySelector(ROW_CONTAINER_SELECTOR)) return undefined
  const text = collapse(row.textContent ?? '')
  if (!text || text === name || text.length > MAX_CONTEXT_LENGTH) return undefined
  // 去掉元素自身的名字，剩下的才是「这一项是谁」。
  const withoutSelf = name ? collapse(text.split(name).join(' ')) : text
  return withoutSelf || undefined
}

/**
 * 收集白名单内的属性，供模型辨识那些没有文本的元素。
 *
 * 三条过滤：与 `name` 完全相同的不重复输出（纯噪声）、超长的截断、凭据字段整体跳过
 * ——`title="admin123"` 这类把密码写进属性的情况真实存在。
 */
function disclosedAttributes(
  element: Element,
  name: string
): Record<string, string> | undefined {
  const secret = isSecretElement(element)
  const collected: Record<string, string> = {}

  DISCLOSED_ATTRIBUTES.forEach(attribute => {
    const raw = element.getAttribute(attribute)
    if (raw === null) return
    const value = collapse(raw)
    if (!value || value === name) return
    collected[attribute] = secret
      ? '[已脱敏]'
      : value.slice(0, MAX_ATTRIBUTE_LENGTH)
  })

  return Object.keys(collected).length > 0 ? collected : undefined
}

function hasInteractiveDescendant(element: Element, cache?: MeasureCache): boolean {
  // 语义叶子永远是「目标」而非「容器」：`<button>` 里的 `<span>`、`<i>` 只是装饰，
  // 它的名字理应取整段文本。不豁免的话按钮会因为内部有可点子元素而被整个跳过。
  if (element.matches(SEMANTIC_LEAF_SELECTOR)) return false
  if (element.querySelector(CANDIDATE_SELECTOR)) return true
  if (!cache) return false
  return Array.from(element.querySelectorAll('*')).some(child => {
    const childCursor = cache.style(child)?.cursor
    return childCursor !== undefined && INTERACTIVE_CURSORS.has(childCursor)
  })
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


/**
 * 这个元素是否位于一个「本该被收录、却被过滤掉」的可交互元素之内。
 *
 * 用于决定它的文本要不要作为正文输出，理由见调用处。只向上找有限层：菜单项、
 * 按钮这类结构都很浅，无限上溯会把整页正文都判成属于某个祖先容器。
 */
function hasFilteredInteractiveAncestor(
  element: Element,
  detectCursor: boolean,
  cache: MeasureCache
): boolean {
  let current: Element | null = element.parentElement
  for (let depth = 0; depth < 3 && current; depth += 1) {
    const role = roleOf(current, detectCursor, cache)
    if (role && INTERACTIVE_ROLES.has(role)) return true
    current = current.parentElement
  }
  return false
}


/**
 * 这个元素是不是某个 `<label>` 内部的装饰层。
 *
 * `cursor` 是继承属性，整个 label 子树都会被推断成可点：文字、图标、组件库的自定义
 * 样式层各自成项，同一个选项因此重复好几遍。而点它们的效果与点那个控件完全一致，
 * 控件本身又已经在清单里了。
 *
 * 判据取自 HTML 标准而非某个组件库：`<label>` 的语义就是「点我等于操作里面那个控件」。
 *
 * @param declaredWidget 作者显式声明的操作目标（有 `role` 或原生控件）永不算装饰。
 */
function isLabelDecoration(element: Element, declaredWidget: boolean): boolean {
  if (declaredWidget) return false
  const label = element.closest('label')
  return Boolean(
    label && label !== element && label.querySelector('input,select,textarea')
  )
}
