import type { DeadlineScope } from '../contracts/deadline'
import type { PageAdapter } from '../contracts/pageAdapter'
import type { PageAdapterRegistry } from './pageAdapterRegistry'

/** 跳转目标。刻意与具体路由库无关。 */
export interface RouterLocation {
  name: string
  query: Record<string, string>
}

/**
 * 宿主的路由器，收窄到本包只需要的两个操作。
 *
 * 收得这么窄，是为了让本包在 Vue Router、React Router 或手写的 history 封装上都能直接用，
 * 既不需要适配层，也不引入 peer 依赖。
 */
export interface RouterPort {
  getCurrentRouteName(): string | undefined
  push(location: RouterLocation, signal?: AbortSignal): Promise<unknown>
}

export interface NavigateAndWaitOptions {
  signal?: AbortSignal
  deadline?: DeadlineScope
}

/** 承载请求 ID 的路由 query 参数名的默认值；宿主页面据此读取当前同步请求。 */
export const DEFAULT_REQUEST_ID_QUERY_KEY = 'airlockRequestId'

/**
 * 驱动宿主路由，然后等待目标页面自报家门。
 *
 * 只跳转是不够的：路由在 URL 变化的那一刻就 resolve 了，而真正能接收结果的组件要再过
 * 若干帧才挂载。所有 page 类工具必须等 Adapter，而不是等路由。
 */
export class NavigationCoordinator {
  private readonly router: RouterPort
  private readonly adapters: PageAdapterRegistry
  private readonly timeoutMs: number
  private readonly requestIdQueryKey: string

  constructor(
    router: RouterPort,
    adapters: PageAdapterRegistry,
    timeoutMs = 5000,
    requestIdQueryKey: string = DEFAULT_REQUEST_ID_QUERY_KEY
  ) {
    this.router = router
    this.adapters = adapters
    this.timeoutMs = timeoutMs
    this.requestIdQueryKey = requestIdQueryKey
  }

  /**
   * 跳转到某个页面，并在其 Adapter 挂载后 resolve。
   *
   * @throws {PageWaitTimeoutError} 超时内没有 Adapter 挂载时抛出。
   * @throws 路由器自身的 reject 原因（除非是无害的重复导航）。
   */
  async navigateAndWait(
    moduleId: string,
    routeName: string,
    requestId: string,
    options: NavigateAndWaitOptions = {}
  ): Promise<PageAdapter> {
    try {
      await this.runWithDeadline(options, 'route_navigation', () => {
        const location = {
          name: routeName,
          query: { [this.requestIdQueryKey]: requestId }
        }
        return options.signal
          ? this.router.push(location, options.signal)
          : this.router.push(location)
      })
    } catch (error) {
      if (!this.isSameRouteNavigationDuplicated(error, routeName)) throw error
    }

    return this.runWithDeadline(options, 'page_adapter_wait', () => (
      this.adapters.waitFor(
        moduleId,
        routeName,
        requestId,
        this.timeoutMs,
        options.signal
      )
    ))
  }

  private runWithDeadline<T>(
    options: NavigateAndWaitOptions,
    phase: 'route_navigation' | 'page_adapter_wait',
    operation: () => T | Promise<T>
  ): Promise<T> {
    if (options.deadline) return options.deadline.run(phase, operation)
    try {
      return Promise.resolve(operation())
    } catch (error) {
      return Promise.reject(error)
    }
  }

  /**
   * 吞掉某些路由器发出的「已经在这儿了」这类 reject。
   *
   * Vue Router 对「push 到当前路由」会以 `NavigationDuplicated` 拒绝。而那正是我们想要的
   * 状态，把它当失败处理会打断「人已经在这个页面上、又调用了它的 page 工具」这一常见路径。
   * 外面套了一层路由校验，因此别处真正的重复导航 bug 依然会暴露出来。
   */
  private isSameRouteNavigationDuplicated(error: unknown, routeName: string): boolean {
    return error instanceof Error &&
      error.name === 'NavigationDuplicated' &&
      this.router.getCurrentRouteName() === routeName
  }
}
