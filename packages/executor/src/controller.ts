import {
  accessibleName,
  capturePageWithElements,
  formatSnapshot,
  isElementVisible,
  type CaptureOptions,
  type PageSnapshot
} from './snapshot'
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
    ;(element as HTMLElement).click()
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
   * 复合下拉：点开触发器 → 在浮层里按可见文本点中选项。
   *
   * 认 `role="option"` 而不认各家 class 名。ARIA 角色是组件库共同遵守的契约，绑
   * class 名等于每接一个新 UI 库就得改一次代码。
   */
  private async selectFromPopup(trigger: Element, optionText: string): Promise<void> {
    if (trigger.getAttribute('aria-expanded') !== 'true') {
      ;(trigger as HTMLElement).click()
      // 浮层普遍是异步挂载的，立刻查会一无所获。
      await waitForDomStable(this.options.stable)
    }

    const options = this.popupOptions(trigger)
    if (options.length === 0) {
      throw new PageActionError(
        `索引处的元素不是下拉框，点开后也没有可选项（${trigger.tagName.toLowerCase()}）`
      )
    }

    const matched = options.find(option => optionLabel(option) === optionText)
      // 组件库常在选项里塞图标、勾选标记一类的附加文本，精确匹配会漏掉本该命中的项。
      // 精确优先、包含兜底：反过来会让「坐席」抢先匹配到「坐席组长」。
      ?? options.find(option => optionLabel(option).includes(optionText))
    if (!matched) {
      const available = options.map(optionLabel).join('、')
      throw new PageActionError(`没有名为「${optionText}」的选项。可选：${available}`)
    }

    ;(matched as HTMLElement).click()
    // 选中后浮层收起、表单值回填，都可能是异步的。等稳定再交还，随后的快照才是终态。
    await waitForDomStable(this.options.stable)
  }

  /**
   * 收集浮层中当前可选的项。
   *
   * 两处过滤都不能省：
   * - **可见性**——组件库常把上一个下拉的浮层留在 DOM 里只做隐藏。拿它匹配会点到
   *   用户根本看不见的选项上，而工具照样回报成功，比选不中危险得多。
   * - **禁用**——`aria-disabled` 的项点了没有任何效果，同样是假成功。
   */
  private popupOptions(trigger: Element): Element[] {
    const doc = trigger.ownerDocument
    // 触发器显式指向某个浮层时优先用它：页面上同时开着多个下拉时，全局搜集会串台。
    const ownedId = trigger.getAttribute('aria-controls') ?? trigger.getAttribute('aria-owns')
    const scope = (ownedId && doc.getElementById(ownedId)) || doc
    const found = Array.from(scope.querySelectorAll('[role="option"]'))
    return found.filter(
      option => isElementVisible(option) && option.getAttribute('aria-disabled') !== 'true'
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
    view.document.querySelectorAll<HTMLElement>('*').forEach(node => {
      if (node.scrollHeight <= node.clientHeight + 1) return
      const overflowY = view.getComputedStyle(node).overflowY
      if (overflowY !== 'auto' && overflowY !== 'scroll') return
      const area = node.clientWidth * node.clientHeight
      if (area > bestArea) {
        bestArea = area
        best = node
      }
    })
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

/** 选项的可见文本。优先 `aria-label`：图标型选项的 `textContent` 可能是空的。 */
function optionLabel(option: Element): string {
  return (option.getAttribute('aria-label') ?? option.textContent ?? '').trim()
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
