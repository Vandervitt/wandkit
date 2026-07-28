import type {
  AttributionPort,
  AuthorizationScope,
  InterceptedRequest,
  InterceptionPolicy,
  RequestChannel,
  RequestDisclosure,
  Verdict
} from './types'

/**
 * 拦截器向宿主要一个「拿到判定就去问人」的回调。
 *
 * 刻意不直接依赖 `AgentRuntime` 或 UI 包：判定属于本包，而「怎么问人」属于宿主
 * ——它可能复用运行时的确认队列，也可能是自己的弹窗。保持这层解耦，本包才能在
 * 没有 Agent 运行时的页面上单独使用（治理宿主自有代码的写操作）。
 *
 * @returns 用户是否批准。抛异常按**拒绝**处理——问不出结果时放行，等于把闸门
 *   建在一个可以抛错的回调上。
 */
export type ConfirmRequestHandler = (input: {
  request: InterceptedRequest
  risk: 'write' | 'destructive'
  disclosure?: RequestDisclosure
}) => Promise<boolean>

export interface InterceptorOptions {
  policy: InterceptionPolicy
  attribution: AttributionPort
  authorization?: AuthorizationScope
  confirm: ConfirmRequestHandler
  /**
   * 要接管的通道，缺省全部（`form` 除外，需显式开启以免与宿主表单逻辑打架）。
   *
   * `beacon` 无法挂起，见 {@link InterceptorOptions.onUnholdableRequest}。
   */
  channels?: readonly RequestChannel[]
  /**
   * 命中确认、但所在通道无法挂起时的回调（当前仅 `sendBeacon`）。
   *
   * 默认行为是**拒发并返回 false**：放行等于让一个该确认的写操作直接溜出去。
   * 但这会改变宿主既有行为，因此暴露出来让接入方知情并可上报。
   */
  onUnholdableRequest?(request: InterceptedRequest): void
  /** 每次判定后回调，供宿主写入 trace。 */
  onVerdict?(request: InterceptedRequest, verdict: Verdict): void
}

/**
 * 已安装的拦截器。
 *
 * `install` 必须幂等且可完全卸载：SPA 热更新、测试用例之间都要能干净地装回原样，
 * 否则会叠出多层 patch，一个请求被反复判定。
 */
export interface Interceptor {
  install(): () => void
  readonly installed: boolean
}

/**
 * 创建请求拦截器。
 *
 * 接管 `fetch` / `XMLHttpRequest` / `sendBeacon`（以及显式开启时的表单提交），
 * 按 {@link InterceptionPolicy} 判定，需要确认的请求挂起到用户表态之后再决定
 * 放行或丢弃。
 *
 * 三条实现纪律，写实现时不得妥协：
 *
 * 1. **未命中的请求必须原样透传**，包括 `this` 绑定、参数个数与返回值类型。
 *    宿主代码对 `fetch` 的封装千奇百怪，任何形态上的偏差都会变成难查的怪 bug。
 * 2. **判定失败一律从严**。策略执行本身抛错时按需要确认处理，绝不能因为闸门自己
 *    出错就放行。
 * 3. **拒绝要给出可分辨的失败**，而不是静默丢弃——调用方需要能区分「被用户拒了」
 *    和「网络挂了」，这与核心包用 `cancelled` 标记而非文案判定取消是同一条原则。
 */
export function createInterceptor(_options: InterceptorOptions): Interceptor {
  throw new Error('Not implemented: 阶段 2')
}
