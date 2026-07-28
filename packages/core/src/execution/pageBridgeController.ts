import type { PageAdapterRegistry } from './pageAdapterRegistry'

/** 由宿主页面组件提供的接线。 */
export interface PageBridgeControllerOptions {
  registry: PageAdapterRegistry
  moduleId: string
  routeName: string
  fallbackDelayMs?: number
  registerAdapter(): () => void
  getRequestId(): string | null
  clearRequestId(requestId: string): void
  onFallback(): void
  onPageQueryStart(): void
  onPageQuerySettled(): void
}

/** 同步协议的页面侧。每个已挂载页面一个实例。 */
export interface PageBridgeController {
  enter(): boolean
  leave(): void
  dispose(): void
  prepareApply(requestId: string): void
  runLatestQuery<T>(
    request: () => Promise<T>,
    apply: (response: T) => void | Promise<void>
  ): Promise<void>
}

/**
 * 等待终态多久之后，就认定请求永远不会到达，转而按常规加载页面。
 *
 * 白屏是这里最坏的结果，所以这是刻意加在观察者之上的第二道保险：上游无论出什么岔子，
 * 用户几秒后至少还能拿到一个能用的页面。
 */
const DEFAULT_FALLBACK_DELAY_MS = 5100

/**
 * 协调单个页面在 Agent 驱动的导航中的参与方式。
 *
 * 它解决的问题是：当工具为了注入结果而跳转到某个页面时，该页面**不能**再跑自己的初始
 * 加载——否则它会先用默认筛选条件拉一遍，随后被注入的结果覆盖，用户就会看到表格闪过
 * 一屏错误数据。
 *
 * 因此页面只要发现 URL 上带着 requestId 就跳过自身加载，转而依赖这个控制器告诉它发生了
 * 什么。任何非 `completed` 的结果，都必须把页面放回常规加载路径。
 */
export function createPageBridgeController(
  options: PageBridgeControllerOptions
): PageBridgeController {
  let unregisterAdapter: (() => void) | null = null
  let requestUnsubscribe: (() => void) | null = null
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null
  let queryVersion = 0

  function clearFallback(): void {
    if (!fallbackTimer) return
    clearTimeout(fallbackTimer)
    fallbackTimer = null
  }

  function clearRequestObserver(): void {
    if (!requestUnsubscribe) return
    const unsubscribe = requestUnsubscribe
    requestUnsubscribe = null
    unsubscribe()
  }

  function register(): void {
    if (!unregisterAdapter) unregisterAdapter = options.registerAdapter()
  }

  /**
   * 观察某个请求的终态。
   *
   * @returns 终态早已发生并被同步投递时返回 `true`——此时无需再挂兜底定时器。
   */
  function observeRequest(requestId: string): boolean {
    clearRequestObserver()
    let settled = false
    const unsubscribe = options.registry.observeRequest(
      options.moduleId,
      options.routeName,
      requestId,
      state => {
        settled = true
        requestUnsubscribe = null
        clearFallback()
        // completed 时页面已经拿到了注入结果，只需清理路由参数即可。
        // failed / invalidated 时，页面既跳过了自身的初始加载，又没拿到结果——不回退就会
        // 一直白屏。但如果更新的请求已经接管了路由，此刻回退会与新请求相互覆盖，
        // 因此只有「本请求仍是当前请求」时才回退。
        const shouldFallback = state !== 'completed' && options.getRequestId() === requestId
        options.clearRequestId(requestId)
        if (shouldFallback) options.onFallback()
      }
    )
    if (!settled) requestUnsubscribe = unsubscribe
    return settled
  }

  /**
   * 为观察者始终不触发的请求准备的最后手段定时器。
   *
   * 动手前会重新检查是否仍是当前请求：等它触发时，页面可能已经合法地归属于一个更新的
   * 请求，此时回退就会和新请求打架。
   */
  function scheduleFallback(requestId: string): void {
    clearFallback()
    fallbackTimer = setTimeout(() => {
      fallbackTimer = null
      if (options.getRequestId() !== requestId) return
      if (options.registry.isLatestRequest(
        options.moduleId,
        options.routeName,
        requestId
      )) return
      clearRequestObserver()
      queryVersion += 1
      options.registry.invalidateRequest(
        options.moduleId,
        options.routeName,
        requestId
      )
      options.clearRequestId(requestId)
      options.onFallback()
    }, options.fallbackDelayMs ?? DEFAULT_FALLBACK_DELAY_MS)
  }

  /** @throws 该请求已被取代、不得再触碰页面时抛出。 */
  function assertCurrent(requestId: string): void {
    if (!options.registry.isLatestRequest(
      options.moduleId,
      options.routeName,
      requestId
    )) {
      throw new Error('Page sync request is no longer current')
    }
    const pendingRequestId = options.getRequestId()
    if (pendingRequestId && pendingRequestId !== requestId) {
      throw new Error('Page sync request is no longer current')
    }
  }

  function leave(): void {
    clearFallback()
    clearRequestObserver()
    queryVersion += 1
    options.onPageQuerySettled()
    options.registry.invalidateLatestRequest(options.moduleId, options.routeName)
    if (unregisterAdapter) {
      const unregister = unregisterAdapter
      unregisterAdapter = null
      unregister()
    }
  }

  return {
    enter() {
      register()
      const requestId = options.getRequestId()
      if (!requestId) return false
      if (!observeRequest(requestId)) scheduleFallback(requestId)
      return true
    },
    leave,
    dispose: leave,
    prepareApply(requestId) {
      assertCurrent(requestId)
      clearFallback()
      queryVersion += 1
      options.onPageQuerySettled()
    },
    /**
     * 执行页面自身发起的查询，只应用最新那一次的响应。
     *
     * 用于防乱序到达：请求前捕获一个版本号，返回后再核对，这样慢的早请求就覆盖不掉快的
     * 晚请求——即筛选条件密集的后台表格里那个经典的陈旧响应 bug。Agent 注入和离开页面
     * 也会推进这个计数器，因此两者都能取消仍在途的查询。
     */
    async runLatestQuery<T>(
      request: () => Promise<T>,
      apply: (response: T) => void | Promise<void>
    ): Promise<void> {
      const requestVersion = ++queryVersion
      options.onPageQueryStart()
      try {
        const response = await request()
        if (requestVersion === queryVersion) await apply(response)
      } finally {
        if (requestVersion === queryVersion) options.onPageQuerySettled()
      }
    }
  }
}
