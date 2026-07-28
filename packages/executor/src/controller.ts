import {
  capturePageWithElements,
  formatSnapshot,
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

  /** 停止路由侦测并还原被包装的 history 方法。 */
  dispose(): void {
    this.routeWatcher?.stop()
    this.routeWatcher = undefined
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
      throw new Error(`索引 ${index} 的元素是只读的，无法输入；若是下拉选择器请改用选择`)
    }
    if (!isTextInput(element)) {
      throw new Error(`索引 ${index} 的元素不支持输入（${element.tagName.toLowerCase()}）`)
    }
    const field = element as HTMLInputElement | HTMLTextAreaElement
    field.focus()
    field.value = text
    // 必须补派发事件：Vue/React 的双向绑定监听的是 input/change，直接赋值它们感知不到，
    // 会出现「界面上有值但框架状态是空」的错位。
    field.dispatchEvent(new Event('input', { bubbles: true }))
    field.dispatchEvent(new Event('change', { bubbles: true }))
  }

  select(index: number, optionText: string): void {
    const element = this.elementAt(index)
    assertEnabled(element)
    if (element.tagName.toLowerCase() !== 'select') {
      throw new Error(`索引 ${index} 的元素不是下拉框`)
    }
    const select = element as HTMLSelectElement
    const options = Array.from(select.options)
    const matched = options.find(option => option.textContent?.trim() === optionText)
    if (!matched) {
      const available = options.map(option => option.textContent?.trim()).join('、')
      throw new Error(`没有名为「${optionText}」的选项。可选：${available}`)
    }
    select.value = matched.value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  }

  scroll(pages = 1): void {
    const view = typeof window === 'undefined' ? undefined : window
    if (!view) return
    view.scrollBy({ top: view.innerHeight * pages, behavior: 'auto' })
  }

  /**
   * 按索引取回元素。
   *
   * 三道校验缺一不可：没 capture 过、越界、以及元素已脱离文档——最后一条是逐步重读
   * 模式的核心约束，模型很容易拿着上一轮的索引继续操作。
   */
  private elementAt(index: number): Element {
    if (this.routeChangedAt) {
      throw new Error(
        `页面已跳转到 ${this.routeChangedAt}，此前的索引全部失效，请重新读取页面`
      )
    }
    if (!this.captured) {
      throw new Error('请先 capture 当前页面，再按索引操作')
    }
    if (!Number.isInteger(index) || index < 0 || index >= this.captured.length) {
      throw new Error(`索引 ${index} 越界，有效范围 0-${this.captured.length - 1}`)
    }
    const element = this.captured[index]
    if (!element.isConnected) {
      throw new Error(`索引 ${index} 指向的元素已不在当前文档中，请重新读取页面`)
    }
    return element
  }
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
    throw new Error('该元素已禁用，无法操作')
  }
}
