/**
 * `@toolairlock/executor` —— 通用 DOM 操作原语。
 *
 * 让 Agent 无需逐个声明业务能力，就能操作任意页面：声明 4 个原语（读页面、点击、
 * 输入、选择），Agent 能做的事就等于用户在界面上能做的事。
 *
 * 两条贯穿设计的原则：
 *
 * 1. **无状态逐步重读。** 不维护能力目录——SPA 的可操作项随数据、权限和组件状态
 *    变化，缓存下来的目录立刻过时。每次动作前重新读当前页，永远是当前真相。
 * 2. **只用生产构建后存活的线索。** 可访问性角色、可访问名、原生属性、文本。
 *    CSS class 会被压成 `_dangerButton_wukff_1`，组件名直接蒸发（已实测）。
 *
 * ⚠ **本包不含任何闸门。** 点击是否危险，要等请求层拦截器按实际发出的请求判定。
 * 在拦截器落地之前，不要把这组原语接到生产环境。
 */
export {
  capturePage,
  capturePageWithElements,
  formatSnapshot,
  DEFAULT_VIEWPORT_EXPANSION
} from './snapshot'
export type {
  PageSnapshot,
  SnapshotElement,
  CaptureResult,
  CaptureOptions
} from './snapshot'

export { PageController } from './controller'
export type { PageControllerOptions } from './controller'

export {
  watchRouteChanges,
  waitForDomStable,
  DEFAULT_QUIET_MS,
  DEFAULT_STABLE_TIMEOUT_MS
} from './routeWatcher'
export type {
  RouteWatcher,
  RouteWatcherOptions,
  WaitForStableOptions
} from './routeWatcher'

export { createPageTools } from './tools'
export type { PageToolOptions } from './tools'
