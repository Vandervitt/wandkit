/**
 * 路由变化侦测与 DOM 稳定等待。
 *
 * 逐步重读模式有一条硬约束：**索引只对产生它的那次快照有效**。SPA 路由切换会整体
 * 替换 DOM，此时上一次快照的每一个索引都失效了。仅靠动作时的「元素已脱离文档」兜底
 * 是不够的——那个报错来得晚，且说不清到底发生了什么。
 *
 * 因此把路由变化做成**主动信号**：变了就作废索引、等 DOM 稳定、重新抓取。
 *
 * 三条原生信号即可覆盖 Vue Router / React Router / 手写 history 封装，**不依赖任何
 * 路由库**——与本项目 `RouterPort` 的窄端口风格一致。
 */

/** 认定 DOM 已稳定所需的静默时长。 */
export const DEFAULT_QUIET_MS = 300

/** 等待稳定的上限。超时也返回，见 {@link waitForDomStable}。 */
export const DEFAULT_STABLE_TIMEOUT_MS = 2000

export interface RouteWatcherOptions {
  /** 路由发生变化时回调。同一次变化只触发一次。 */
  onRouteChange(url: string): void
  /** 注入 window，便于测试。缺省用全局。 */
  view?: Window
}

export interface RouteWatcher {
  /** 停止侦测并还原被包装的 history 方法。 */
  stop(): void
}

/**
 * 开始侦测路由变化。
 *
 * `popstate` 与 `hashchange` 是浏览器原生派发的；而 `pushState` / `replaceState`
 * **不派发任何事件**——这正是绝大多数 SPA 路由前进时走的路径，因此必须包装。
 *
 * 包装是可还原的：{@link RouteWatcher.stop} 会把原方法装回去。不还原的话，测试之间
 * 会叠出多层包装，一次跳转触发 N 次回调。
 */
export function watchRouteChanges(options: RouteWatcherOptions): RouteWatcher {
  const view = options.view ?? (typeof window === 'undefined' ? undefined : window)
  if (!view) return { stop: () => undefined }

  const history = view.history
  let lastUrl = view.location.href
  let stopped = false

  const notify = (): void => {
    if (stopped) return
    const url = view.location.href
    // 去重：一次跳转常常同时触发 pushState 与 popstate。
    if (url === lastUrl) return
    lastUrl = url
    options.onRouteChange(url)
  }

  // pushState/replaceState 是同步的，但框架往往在其后才渲染。放进微任务，
  // 让调用方栈先跑完，避免拿到一个还没开始更新的 DOM。
  const notifyAsync = (): void => {
    Promise.resolve().then(notify)
  }

  const originalPush = history.pushState
  const originalReplace = history.replaceState

  history.pushState = function pushState(...args: Parameters<History['pushState']>) {
    const result = originalPush.apply(this, args)
    notifyAsync()
    return result
  }
  history.replaceState = function replaceState(
    ...args: Parameters<History['replaceState']>
  ) {
    const result = originalReplace.apply(this, args)
    notifyAsync()
    return result
  }

  view.addEventListener('popstate', notify)
  view.addEventListener('hashchange', notify)

  return {
    stop() {
      if (stopped) return
      stopped = true
      // 仅当仍是我们装上去的那个函数时才还原：期间可能有别人也包装了一层，
      // 直接覆盖会把人家的包装抹掉。
      if (history.pushState !== originalPush) history.pushState = originalPush
      if (history.replaceState !== originalReplace) history.replaceState = originalReplace
      view.removeEventListener('popstate', notify)
      view.removeEventListener('hashchange', notify)
    }
  }
}

export interface WaitForStableOptions {
  /** 连续多久无 DOM 变更即认定稳定，缺省 {@link DEFAULT_QUIET_MS}。 */
  quietMs?: number
  /** 等待上限，缺省 {@link DEFAULT_STABLE_TIMEOUT_MS}。 */
  timeoutMs?: number
  /** 观察范围，缺省 `document`。 */
  root?: Node
}

/**
 * 等到 DOM 连续一段时间没有变更。
 *
 * 路由切换与异步渲染之间存在间隙，立刻抓取会拿到半成品——菜单还没渲染、表格还在
 * 骨架屏。用 `MutationObserver` 的静默期作为判据，比固定 `sleep` 既快又稳。
 *
 * **超时一定返回而不是抛错。** 有些页面存在轮询、动画、自动刷新，DOM 永远静不下来；
 * 拿到一个不完整的快照，远好过让整个 Run 卡死在这里。
 *
 * @returns 是否在超时前达到了静默（`false` 表示是超时返回的，调用方可据此降低对
 *   快照完整性的预期）。
 */
export function waitForDomStable(
  options: WaitForStableOptions = {}
): Promise<boolean> {
  const quietMs = options.quietMs ?? DEFAULT_QUIET_MS
  const timeoutMs = options.timeoutMs ?? DEFAULT_STABLE_TIMEOUT_MS
  const root = options.root ?? (typeof document === 'undefined' ? undefined : document)
  if (!root || typeof MutationObserver === 'undefined') return Promise.resolve(true)

  return new Promise<boolean>(resolve => {
    let quietTimer: ReturnType<typeof setTimeout> | undefined
    let settled = false

    const finish = (stable: boolean): void => {
      if (settled) return
      settled = true
      if (quietTimer) clearTimeout(quietTimer)
      clearTimeout(deadline)
      observer.disconnect()
      resolve(stable)
    }

    const restartQuietTimer = (): void => {
      if (quietTimer) clearTimeout(quietTimer)
      quietTimer = setTimeout(() => finish(true), quietMs)
    }

    const observer = new MutationObserver(restartQuietTimer)
    const deadline = setTimeout(() => finish(false), timeoutMs)

    observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: false
    })
    restartQuietTimer()
  })
}
