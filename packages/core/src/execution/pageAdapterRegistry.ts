import type { PageAdapter } from '../contracts/pageAdapter'

/**
 * 目标页面在超时前没有挂载出匹配的 Adapter。
 *
 * 单独定义一个类而不是用普通 Error，是因为调用方必须把它和「路由被拒绝」区分开，
 * 才能选对给用户看的文案。靠比对 message 文本来区分，会在文案被翻译的那一刻失效——
 * 和 `ToolResult.cancelled` 要规避的是同一种失败模式。
 */
export class PageWaitTimeoutError extends Error {
  constructor(
    readonly moduleId: string,
    readonly routeName: string,
    readonly requestId: string
  ) {
    super(`Timed out waiting for page: ${moduleId}/${routeName} (${requestId})`)
    this.name = 'PageWaitTimeoutError'
  }
}

/** A pending {@link PageAdapterRegistry.waitFor} promise. */
interface AdapterWaiter {
  resolve(adapter: PageAdapter): void
  reject(error: Error): void
  timeout: ReturnType<typeof setTimeout>
}

/**
 * 页面同步请求的终结方式。
 *
 * - `completed` —— 页面收到并应用了注入的结果。
 * - `failed` —— 效果无法应用。
 * - `invalidated` —— 更新的请求接管了，或用户已离开页面。
 *
 * 页面需要区分这三者，因为只有 `completed` 意味着它已经拿到数据；另外两种情况下
 * 它必须回退到自行加载，否则会永远白屏。
 */
export type PageRequestTerminalState = 'completed' | 'failed' | 'invalidated'
type PageRequestState = 'pending' | PageRequestTerminalState
type PageRequestListener = (state: PageRequestTerminalState) => void
const noop = (): undefined => undefined

/**
 * 为尚未订阅的观察者保留终态多久。
 *
 * 略大于页面桥自身的兜底延时，确保桥总能在记录被回收前观察到真实结果。
 */
const DEFAULT_LATE_OBSERVER_TERMINAL_TTL_MS = 5100

interface PageRequestRecord {
  state: PageRequestState
  listeners: Set<PageRequestListener>
  /**
   * 达到终态后短暂保留。
   *
   * 当请求是在页面尚未存在时发起的，就会设上这个标记：请求可能在页面还在挂载的过程中
   * 就结束了（通常是失败），此时观察者是事后才到的，不保留的话它什么也看不到，然后一直挂着。
   */
  retainTerminalForLateObserver: boolean
  terminalRetentionTimeout?: ReturnType<typeof setTimeout>
}

/**
 * 跟踪哪些页面 Adapter 处于挂载状态，以及每个指向它们的页面同步请求的生命周期。
 *
 * 两个必须放在一起的职责：
 *
 * 1. **挂载跟踪** —— 页面挂载时注册、卸载时注销，Runtime 据此决定是直接用 Adapter，
 *    还是等一个出现。
 * 2. **请求仲裁** —— 每个页面同时最多只有一个「最新」的同步请求，更早的一律作废。
 *    正是它拦住了「慢的第一次查询覆盖掉快的第二次查询结果」这个经典竞态。
 */
export class PageAdapterRegistry {
  private readonly adapters = new Map<string, PageAdapter>()
  private readonly waiters = new Map<string, Set<AdapterWaiter>>()
  private readonly latestRequests = new Map<string, string>()
  private readonly requestRecords = new Map<string, Map<string, PageRequestRecord>>()
  private readonly lateObserverTerminalTtlMs: number

  constructor(lateObserverTerminalTtlMs = DEFAULT_LATE_OBSERVER_TERMINAL_TTL_MS) {
    this.lateObserverTerminalTtlMs = lateObserverTerminalTtlMs
  }

  /**
   * 注册一个已挂载的页面 Adapter。
   *
   * 非生产环境下重复注册会抛错。它几乎总意味着页面挂了两次或忘了注销，而由此产生的
   * 静默覆盖从症状（结果落到了错误的实例上）极难反推。生产环境选择容忍，而不是因为
   * 一个开发期失误把页面搞成白屏。
   *
   * @returns 注销函数。可安全重复调用；若该槽位已被另一个 Adapter 接管则为空操作——
   *   这样一次迟到的卸载不会把顶替它的那个页面给摘掉。
   */
  register(adapter: PageAdapter): () => void {
    const key = this.key(adapter.moduleId, adapter.routeName)
    if (this.adapters.has(key) && process.env.NODE_ENV !== 'production') {
      throw new Error(`Duplicate page adapter: ${adapter.moduleId}/${adapter.routeName}`)
    }

    this.adapters.set(key, adapter)
    this.resolveWaiters(key, adapter)

    return () => {
      if (this.adapters.get(key) === adapter) {
        this.adapters.delete(key)
      }
    }
  }

  get(moduleId: string, routeName: string): PageAdapter | undefined {
    return this.adapters.get(this.key(moduleId, routeName))
  }

  /** 对一个已挂载的页面发起请求。 */
  beginRequest(moduleId: string, routeName: string, requestId: string): void {
    this.beginRequestWithRetention(moduleId, routeName, requestId, false)
  }

  /**
   * 对一个尚未挂载的页面发起请求。
   *
   * 会把终态保留一小段 TTL，好让页面挂载之后，仍能观察到它加载期间就已发生的结果。
   */
  beginRequestAwaitingPageObserver(
    moduleId: string,
    routeName: string,
    requestId: string
  ): void {
    this.beginRequestWithRetention(moduleId, routeName, requestId, true)
  }

  private beginRequestWithRetention(
    moduleId: string,
    routeName: string,
    requestId: string,
    retainTerminalForLateObserver: boolean
  ): void {
    const key = this.key(moduleId, routeName)
    const previousRequestId = this.latestRequests.get(key)
    if (previousRequestId && previousRequestId !== requestId) {
      this.finishRequest(key, previousRequestId, 'invalidated')
    }
    this.deleteRecord(key, requestId)
    this.latestRequests.set(key, requestId)
    this.records(key).set(requestId, {
      state: 'pending',
      listeners: new Set<PageRequestListener>(),
      retainTerminalForLateObserver
    })
  }

  /**
   * 该请求是否仍是其页面的当前请求。
   *
   * 在执行链路上被反复检查——应用效果前、上报成功前——因为中间任何一次 await 都给了
   * 更新的请求接管的机会。
   */
  isLatestRequest(moduleId: string, routeName: string, requestId: string): boolean {
    return this.latestRequests.get(this.key(moduleId, routeName)) === requestId
  }

  completeRequest(moduleId: string, routeName: string, requestId: string): void {
    this.finishRequest(this.key(moduleId, routeName), requestId, 'completed')
  }

  invalidateRequest(moduleId: string, routeName: string, requestId: string): void {
    this.finishRequest(this.key(moduleId, routeName), requestId, 'invalidated')
  }

  failRequest(moduleId: string, routeName: string, requestId: string): void {
    this.finishRequest(this.key(moduleId, routeName), requestId, 'failed')
  }

  invalidateLatestRequest(moduleId: string, routeName: string): void {
    const key = this.key(moduleId, routeName)
    const requestId = this.latestRequests.get(key)
    if (requestId) this.finishRequest(key, requestId, 'invalidated')
  }

  /**
   * 订阅某个请求的终态。
   *
   * 若请求已经结束且终态被保留过，监听器会同步触发，随后记录立即回收。
   *
   * @returns 退订函数；请求未知或终态已投递时为空操作。
   */
  observeRequest(
    moduleId: string,
    routeName: string,
    requestId: string,
    listener: PageRequestListener
  ): () => void {
    const key = this.key(moduleId, routeName)
    const records = this.requestRecords.get(key)
    const record = records?.get(requestId)
    if (!record) return noop
    if (record.state !== 'pending') {
      const state = record.state
      this.deleteRecord(key, requestId)
      this.notifyListener(listener, state)
      return noop
    }
    record.listeners.add(listener)
    return () => {
      record.listeners.delete(listener)
    }
  }

  /**
   * 等到页面的 Adapter 挂载后 resolve。
   *
   * @throws {PageWaitTimeoutError} `timeoutMs` 内没有任何 Adapter 挂载时抛出。
   */
  waitFor(
    moduleId: string,
    routeName: string,
    requestId: string,
    timeoutMs: number
  ): Promise<PageAdapter> {
    const key = this.key(moduleId, routeName)
    const mounted = this.adapters.get(key)
    if (mounted) return Promise.resolve(mounted)

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const waiters = this.waiters.get(key)
        waiters?.delete(waiter)
        if (waiters?.size === 0) this.waiters.delete(key)
        reject(new PageWaitTimeoutError(moduleId, routeName, requestId))
      }, timeoutMs)
      const waiter: AdapterWaiter = { resolve, reject, timeout }
      const waiters = this.waiters.get(key) ?? new Set<AdapterWaiter>()
      waiters.add(waiter)
      this.waiters.set(key, waiters)
    })
  }

  private resolveWaiters(key: string, adapter: PageAdapter): void {
    const waiters = this.waiters.get(key)
    if (!waiters) return

    this.waiters.delete(key)
    waiters.forEach((waiter) => {
      clearTimeout(waiter.timeout)
      waiter.resolve(adapter)
    })
  }

  private key(moduleId: string, routeName: string): string {
    return `${moduleId}::${routeName}`
  }

  /**
   * 把请求推进到终态，并且只通知观察者一次。
   *
   * 派发**之前**先复制监听器列表并删除记录，这样某个同步发起新请求的监听器，就不会
   * 重入到一条正在拆除中的记录里。
   */
  private finishRequest(
    key: string,
    requestId: string,
    state: PageRequestTerminalState
  ): void {
    if (this.latestRequests.get(key) === requestId) {
      this.latestRequests.delete(key)
    }
    const records = this.requestRecords.get(key)
    const record = records?.get(requestId)
    if (!records || !record) return
    record.state = state
    if (record.listeners.size === 0) {
      if (record.retainTerminalForLateObserver) {
        record.terminalRetentionTimeout = setTimeout(() => {
          this.deleteRecord(key, requestId)
        }, this.lateObserverTerminalTtlMs)
      } else {
        this.deleteRecord(key, requestId)
      }
      return
    }
    const listeners = [...record.listeners]
    this.deleteRecord(key, requestId)
    listeners.forEach(listener => this.notifyListener(listener, state))
  }

  private records(key: string): Map<string, PageRequestRecord> {
    const records = this.requestRecords.get(key) ?? new Map<string, PageRequestRecord>()
    this.requestRecords.set(key, records)
    return records
  }

  private deleteEmptyRecords(key: string): void {
    if (this.requestRecords.get(key)?.size === 0) {
      this.requestRecords.delete(key)
    }
  }

  private deleteRecord(key: string, requestId: string): void {
    const records = this.requestRecords.get(key)
    const record = records?.get(requestId)
    if (!records || !record) return
    if (record.terminalRetentionTimeout) {
      clearTimeout(record.terminalRetentionTimeout)
    }
    records.delete(requestId)
    this.deleteEmptyRecords(key)
  }

  private notifyListener(
    listener: PageRequestListener,
    state: PageRequestTerminalState
  ): void {
    try {
      listener(state)
    } catch (_error) {
      // 观察者自身的异常不得改变请求发起方的终态结果。
    }
  }
}
