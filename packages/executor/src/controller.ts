import {
  accessibleName,
  capturePageWithElements,
  formatSnapshot,
  isElementVisible,
  type CaptureOptions,
  type PageSnapshot
} from './snapshot'
import {
  closestComposed,
  composedContains,
  composedElements,
  composedTextContent
} from './composedTree'
import {
  waitForDomStable,
  watchRouteChanges,
  type RouteWatcher,
  type WaitForStableOptions
} from './routeWatcher'

/**
 * 模型可以自行纠正的操作失败。
 *
 * 「索引失效了」「这个元素是只读的」「没有这个选项」——这些**不是程序缺陷**，而是
 * 逐步重读模式下预期内的模型行为，和参数校验失败同类。它们的正确归宿是回喂给模型
 * 让它下一轮改正，而不是当成异常炸出去。
 *
 * 之所以要单独一个类型：`tools.ts` 只把这一类转成 `ok: false` 的结果，真正的程序
 * 缺陷仍旧照常抛出。不加区分地 `catch (error)` 会把 bug 一起吞掉，变成模型反复重试
 * 一个永远不会成功的动作。
 *
 * 实测教训：这些错误原先直接抛出，被运行时归一成「工具运行失败，请稍后重试」——
 * 模型第一步没读页面就点击，拿到的是这句毫无信息量的话，Run 当场判死。
 */
export class PageActionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PageActionError'
  }
}

/**
 * 页面控制器：持有「上一次快照的索引 → 真实元素」的映射，并在其上执行动作。
 *
 * 索引之所以要由控制器保管而不是交给模型自己算，是因为**索引只对产生它的那一次
 * 快照有效**。页面一变，第 3 个按钮就可能已经不是原来那个了。所有动作因此都会先
 * 校验元素是否仍在文档中，宁可报错也不能操作到错的元素上——后者会让模型基于一个
 * 错误的成功前提继续推理下去。
 */
export interface PageControllerOptions extends CaptureOptions {
  /**
   * 是否侦测路由变化并自动作废索引，缺省开启。
   *
   * 关掉的话，SPA 路由切换后模型仍可能拿着旧索引操作——虽然 `elementAt` 的脱离文档
   * 检查能兜住，但报错来得晚且说不清原因。
   */
  watchRoute?: boolean
  /** 传给 {@link waitForDomStable} 的参数。 */
  stable?: WaitForStableOptions
}

export class PageController {
  private captured: Element[] | null = null
  /** 上一次抓取见过的元素，用于标注新出现的那些。首次抓取前为 `null`。 */
  private seen: WeakSet<Element> | null = null
  private readonly options: PageControllerOptions
  private routeWatcher?: RouteWatcher
  /** 路由已变、但尚未重新抓取。此时任何按旧索引的操作都必须被拒绝。 */
  private routeChangedAt: string | null = null

  constructor(options: PageControllerOptions = {}) {
    this.options = options
    if (options.watchRoute !== false) {
      this.routeWatcher = watchRouteChanges({
        onRouteChange: url => {
          // 不在这里自动重抓：抓取时机应由调用方决定（通常是模型下一次读页面），
          // 这里只负责把旧索引钉死，避免它被继续使用。
          this.captured = null
          this.routeChangedAt = url
        }
      })
    }
  }

  /** 重新读取当前页面，并刷新索引映射。 */
  capture(root: ParentNode = document): PageSnapshot {
    const { snapshot, elements } = capturePageWithElements(root, this.options)
    // 标注新元素：上一次没见过的，说明是刚才那次操作弄出来的（下拉展开、弹窗出现）。
    // 首次抓取不标记——那时整页都是新的，全标等于没标。
    if (this.seen) {
      const seen = this.seen
      elements.forEach((element, index) => {
        if (!seen.has(element)) snapshot.elements[index].isNew = true
      })
    }
    this.seen = new WeakSet(elements)
    this.captured = elements
    this.routeChangedAt = null
    return snapshot
  }

  /**
   * 等 DOM 稳定后再读取。
   *
   * 路由切换或提交之后应当用它：立刻抓取会拿到骨架屏、未渲染完的菜单一类的半成品。
   */
  async captureStable(root: ParentNode = document): Promise<PageSnapshot> {
    await waitForDomStable(this.options.stable)
    return this.capture(root)
  }

  /** 当前快照的文本形式，直接交给模型。 */
  format(root: ParentNode = document): string {
    return formatSnapshot(this.capture(root))
  }

  /**
   * 等 DOM 稳定后的文本快照。动作之后用它。
   *
   * 动作立刻抓到的往往是半成品：弹窗还在做进场动画、路由切过去了但内容没渲染完。
   * 把这种快照回给模型，它会基于一份即将作废的清单挑索引。
   */
  async formatStable(root: ParentNode = document): Promise<string> {
    return formatSnapshot(await this.captureStable(root))
  }

  /**
   * 当前页面上可见的表单校验错误。
   *
   * **它存在的理由是杜绝假成功。** 真实接入实测：模型填完表单点了「OK」，点击本身
   * 确实发生了，工具回报 `已点击「OK」`——模型据此宣布「已成功添加新员工」。而实际上
   * 密码不符合规则、角色没选，表单被前端校验拦下，一个请求都没发出去。用户看到的是
   * 一句自信的成功，和一个红着两处错误、什么也没提交的弹窗。
   *
   * 判据是 `role="alert"` **且位于 `<form>` 之内**，两个条件缺一不可：
   *
   * - `role="alert"` 是 ARIA 给校验反馈的标准角色，AntD、Element Plus 等都遵守它，
   *   比绑 `.ant-form-item-explain-error` 这类 class 名健壮得多（真实页面实测确认
   *   AntD Vue 4 用的正是它；`aria-invalid` 它反而不设，因此那条路走不通）。
   * - **必须限定在表单内**：成功提示（`.ant-message` 之流）同样用 `role="alert"`，
   *   但挂在 body 上、不在任何表单里。不加这层限制，一次成功的保存会被判成失败。
   */
  validationErrors(): string[] {
    if (typeof document === 'undefined') return []
    return Array.from(composedElements(document))
      .filter(element => element.matches('[role="alert"]'))
      .filter(alert => closestComposed(alert, 'form') && isElementVisible(alert))
      .map(alert => collapseText(composedTextContent(alert)))
      .filter(text => text !== '')
      // 同一条错误常被内外两层节点各渲染一遍（AntD 就是 explain / explain-error 两层）。
      .filter((text, index, all) => all.indexOf(text) === index)
  }

  /** 停止路由侦测并还原被包装的 history 方法。 */
  dispose(): void {
    this.routeWatcher?.stop()
    this.routeWatcher = undefined
  }

  /**
   * 某个索引对应元素的可见名称，用于把动作描述成业务语言。
   *
   * 「已点击 [9]」既没法让用户看懂正在发生什么，回喂给模型时也不构成任何依据——
   * 下标不是事实，元素上写着的字才是。取不到名字时返回空串，由调用方决定怎么退化。
   *
   * **必须在动作之前取**：点击往往会让元素当场从文档里消失，事后再取就是空的。
   */
  label(index: number): string {
    try {
      return accessibleName(this.elementAt(index))
    } catch (_error) {
      // 取名字失败不该阻断动作本身——真正的索引校验在动作里做，报错也由它来报。
      return ''
    }
  }

  click(index: number): void {
    const element = this.elementAt(index)
    assertEnabled(element)
    pressAndClick(element as HTMLElement)
  }

  input(index: number, text: string): void {
    const element = this.elementAt(index)
    assertEnabled(element)
    // 只读控件必须先于「能否输入」判断：组件库常用 readonly input 实现下拉，
    // 往里赋值不会报错但也毫无效果，模型会误以为筛选条件已经填好了。
    if (isReadonlyElement(element)) {
      throw new PageActionError(`索引 ${index} 的元素是只读的，无法输入；若是下拉选择器请改用选择`)
    }
    if (!isTextInput(element)) {
      throw new PageActionError(`索引 ${index} 的元素不支持输入（${element.tagName.toLowerCase()}）`)
    }
    const field = element as HTMLInputElement | HTMLTextAreaElement
    field.focus()
    field.value = text
    // 必须补派发事件：Vue/React 的双向绑定监听的是 input/change，直接赋值它们感知不到，
    // 会出现「界面上有值但框架状态是空」的错位。
    field.dispatchEvent(new Event('input', { bubbles: true }))
    field.dispatchEvent(new Event('change', { bubbles: true }))
  }

  /**
   * 按可见文本选中一项，原生 `<select>` 与组件库的复合下拉都走这里。
   *
   * **复合下拉必须支持**，否则它是一条死路：AntD / Element Plus 之流用
   * 「readonly input（或 combobox）+ 浮层」实现下拉，`input` 原语因只读而拒绝它，
   * 原来的 `select` 又因不是 `<select>` 而拒绝它——模型两头碰壁，随后开始声称自己
   * 无法操作这个系统。真实接入实测到的正是这一幕（新建员工表单的「角色」字段）。
   */
  async select(index: number, optionText: string): Promise<void> {
    const element = this.elementAt(index)
    assertEnabled(element)
    if (element.tagName.toLowerCase() === 'select') {
      selectNative(element as HTMLSelectElement, optionText)
      return
    }
    await this.selectFromPopup(element, optionText)
  }

  /**
   * 复合下拉：点开触发器 → 在**新出现的可点元素**里按可见文本点中选项。
   *
   * **刻意不认 `role="option"`，也不信 `aria-controls`。** 真实页面实测
   * （AntD Vue 4 / rc-select）：`aria-controls` 指向的 `rc_select_N_list` 是一棵纯
   * 无障碍镜像——里面的 `role="option"` 全是空文本、不可见、无 class 的占位 div，
   * 只服务于 `aria-activedescendant`；真正的可见选项是 `.ant-select-item-option`，
   * 长在另一棵 `.ant-select-dropdown` 上，**不带任何 role**。
   *
   * 于是「认 role=option」这条契约恰好命中诱饵：扫到一把空节点，可见性一过滤就全没
   * 了，报「点开后也没有可选项」。模型连试四次后放弃了整个字段。
   *
   * 改判据为「点开之后新出现、看得见、可点、有名字」——这正是快照本来就在算的东西
   * （可见性、遮挡、`cursor: pointer` 兜底、`isNew` 标注）。复用它既不必为每家 UI 库
   * 单写适配，也自动继承后续所有快照层面的改进。
   */
  private async selectFromPopup(trigger: Element, optionText: string): Promise<void> {
    if (!isExpanded(trigger)) {
      pressAndClick(trigger as HTMLElement)
      // 浮层普遍是异步挂载的，立刻查会一无所获。
      await waitForDomStable(this.options.stable)
    }

    const snapshot = this.capture()
    const captured = this.captured ?? []
    const pool = snapshot.elements
      .map((meta, index) => ({ meta, dom: captured[index] }))
      // 触发器自身及其内部元素排除掉：点回触发器只会把刚打开的浮层收起来。
      .filter(item => item.dom && item.dom !== trigger &&
        !composedContains(trigger, item.dom))
      .filter(item => item.meta.name)

    // 优先只在「新出现的」里找。页面别处很可能本来就有同名文字（表格里的角色列就是
    // 一例），不加这层限制会点到浮层外面去，而工具照样回报成功。
    const fresh = pool.filter(item => item.meta.isNew)
    const matched = pickOption(fresh, optionText) ?? pickOption(pool, optionText)
    if (matched) {
      pressAndClick(matched.dom as HTMLElement)
      // 选中后浮层收起、表单值回填都可能是异步的。等稳定再交还，随后的快照才是终态。
      await waitForDomStable(this.options.stable)
      return
    }

    // 报错要说实话，且必须区分这两种情况——它们的下一步完全不同：点开了但没这一项，
    // 模型该改选别的；压根没弹出任何东西，模型该去确认这元素究竟是不是下拉框。
    if (fresh.length === 0) {
      throw new PageActionError(
        `点开索引处的元素后没有出现任何可选项，它可能不是下拉框（${trigger.tagName.toLowerCase()}）`
      )
    }
    throw new PageActionError(
      `没有名为「${optionText}」的选项。可选：${fresh.map(item => item.meta.name).join('、')}`
    )
  }

  /**
   * 滚动页面，或滚动某个内部容器。
   *
   * 给了 `index` 就滚那个容器——快照里标为 `scrollable` 的元素页面级滚动够不到，
   * 不单独支持的话它下半截的内容对 Agent 永远不存在。
   *
   * **不给 `index` 时，整页滚不动就自动回退到页面内最大的滚动容器。** 管理后台几乎
   * 都是这个布局：`window` 完全不滚，内容区是独立的 `overflow` 容器。而模型分不清该
   * 滚哪一个——真实接入实测：说「往下滚」时它滚了整页，页面一动不动，于是它认定下面
   * 没有内容了，转头去点一个名字相近的错误元素。
   *
   * 这个判断不该交给模型：**整页能不能滚是个可观测的事实**，代码自己看得出来，没必要
   * 让它去猜。回退只在「整页确实滚不动」时发生，因此不会抢走本该滚整页的场景。
   *
   * @param pages 滚动几屏，负数向上。
   * @param index 目标容器在最近一次快照中的索引；缺省先试整页，再回退到最大滚动容器。
   */
  scroll(pages = 1, index?: number): void {
    if (index !== undefined) {
      this.scrollBox(this.elementAt(index) as HTMLElement, pages)
      return
    }

    const view = typeof window === 'undefined' ? undefined : window
    if (!view) return

    if (this.isPageScrollable(view)) {
      view.scrollBy({ top: view.innerHeight * pages, behavior: 'auto' })
      return
    }

    const fallback = this.largestScrollable()
    if (fallback) this.scrollBox(fallback, pages)
  }

  private scrollBox(box: HTMLElement, pages: number): void {
    box.scrollBy({ top: box.clientHeight * pages, behavior: 'auto' })
  }

  /** 整页是否真的有可滚的余量。`documentElement` 与 `body` 谁承载滚动都算。 */
  private isPageScrollable(view: Window): boolean {
    const doc = view.document
    return [doc.documentElement, doc.body].some(
      node => node && node.scrollHeight > node.clientHeight + 1
    )
  }

  /**
   * 页面内可滚区域中「最大」的那个，按可见面积算。
   *
   * 用面积而不是滚动高度选：侧边菜单常常也能滚，但它窄，而承载正文的那块总是最宽最高的
   * 一块。挑错了会去滚菜单，页面正文依然不动。
   */
  private largestScrollable(): HTMLElement | undefined {
    const view = typeof window === 'undefined' ? undefined : window
    if (!view) return undefined

    let best: HTMLElement | undefined
    let bestArea = 0
    for (const node of composedElements(view.document)) {
      if (!(node instanceof view.HTMLElement)) continue
      if (node.scrollHeight <= node.clientHeight + 1) continue
      const overflowY = view.getComputedStyle(node).overflowY
      if (overflowY !== 'auto' && overflowY !== 'scroll') continue
      const area = node.clientWidth * node.clientHeight
      if (area > bestArea) {
        bestArea = area
        best = node
      }
    }
    return best
  }

  /**
   * 按索引取回元素。
   *
   * 三道校验缺一不可：没 capture 过、越界、以及元素已脱离文档——最后一条是逐步重读
   * 模式的核心约束，模型很容易拿着上一轮的索引继续操作。
   */
  private elementAt(index: number): Element {
    if (this.routeChangedAt) {
      throw new PageActionError(
        `页面已跳转到 ${this.routeChangedAt}，此前的索引全部失效，请重新读取页面`
      )
    }
    if (!this.captured) {
      throw new PageActionError('请先 capture 当前页面，再按索引操作')
    }
    if (!Number.isInteger(index) || index < 0 || index >= this.captured.length) {
      throw new PageActionError(`索引 ${index} 越界，有效范围 0-${this.captured.length - 1}`)
    }
    const element = this.captured[index]
    if (!element.isConnected) {
      throw new PageActionError(`索引 ${index} 指向的元素已不在当前文档中，请重新读取页面`)
    }
    return element
  }
}

/**
 * 派发一次完整的指针按下—抬起—点击序列。
 *
 * **不能只调 `element.click()`**：那只派发 `click` 事件。真实组件库大量把交互挂在
 * `mousedown` 上——rc-select（Ant Design Vue / React 的下拉底座）就是如此，它的展开
 * 监听在 `mousedown`，`click()` 打不开浮层。真实接入实测：新建员工表单的「角色」
 * 字段点不开，扫不到任何 `role="option"`，模型于是回答「这不是下拉框」。
 *
 * 这不是给下拉打的补丁：日期选择、级联、自定义弹出层同样常用 mousedown（为了抢在
 * 焦点转移之前响应）。按真实用户的事件序列来，才对所有这些一并成立。
 *
 * 末尾仍调 `click()` 而不是自己派发 `click` 事件：原生 `click()` 会带上表单提交、
 * 复选框勾选这些浏览器默认行为，手工构造的事件没有。
 */
function pressAndClick(element: HTMLElement): void {
  const init = { bubbles: true, cancelable: true, composed: true }
  element.dispatchEvent(new MouseEvent('pointerdown', init))
  element.dispatchEvent(new MouseEvent('mousedown', init))
  // 焦点跟随按下发生。缺了它，「失焦即关闭」的浮层会在随后的抬起中立刻收起。
  if (typeof element.focus === 'function') element.focus()
  element.dispatchEvent(new MouseEvent('pointerup', init))
  element.dispatchEvent(new MouseEvent('mouseup', init))
  element.click()
}

function selectNative(select: HTMLSelectElement, optionText: string): void {
  const options = Array.from(select.options)
  const matched = options.find(option => option.textContent?.trim() === optionText)
  if (!matched) {
    const available = options.map(option => option.textContent?.trim()).join('、')
    throw new PageActionError(`没有名为「${optionText}」的选项。可选：${available}`)
  }
  select.value = matched.value
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

/** 折叠空白，供错误文案去掉换行与缩进后再比对去重。 */
function collapseText(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim()
}

/**
 * 下拉是否已经展开。
 *
 * 三处都要查：模型点中的可能是外层包装（`.ant-select-selector`），也可能是内层那个
 * `role="combobox"` 的 input，而 `aria-expanded` 只挂在其中一个上。判错的代价是把
 * 刚打开的浮层又点关掉。
 */
function isExpanded(trigger: Element): boolean {
  if (trigger.getAttribute('aria-expanded') === 'true') return true
  if (closestComposed(trigger, '[aria-expanded="true"]')) return true
  for (const descendant of composedElements(trigger)) {
    if (descendant.getAttribute('aria-expanded') === 'true') return true
  }
  return false
}

/** 精确名字优先，包含兜底——反过来会让「坐席」抢先匹配到「坐席组长」。 */
function pickOption<T extends { meta: { name: string } }>(
  items: T[],
  optionText: string
): T | undefined {
  return items.find(item => item.meta.name === optionText)
    ?? items.find(item => item.meta.name.includes(optionText))
}

function isTextInput(element: Element): boolean {
  const tag = element.tagName.toLowerCase()
  if (tag === 'textarea') return true
  if (tag !== 'input') return element.getAttribute('contenteditable') === 'true'
  const type = (element as HTMLInputElement).type.toLowerCase()
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'file'].includes(type)
}

function isReadonlyElement(element: Element): boolean {
  return (element as HTMLInputElement).readOnly === true ||
    element.getAttribute('aria-readonly') === 'true'
}

function assertEnabled(element: Element): void {
  const disabled = (element as HTMLInputElement).disabled === true ||
    element.getAttribute('aria-disabled') === 'true'
  if (disabled) {
    throw new PageActionError('该元素已禁用，无法操作')
  }
}
