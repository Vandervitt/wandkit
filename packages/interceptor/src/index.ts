/**
 * `@toolairlock/interceptor` —— 请求层的兜底治理。
 *
 * 核心包治理的是**已声明**的工具；本包治理的是**一切走网络的写**，包括从未被声明
 * 成工具的那些。两者是纵深关系，不是替代关系：
 *
 * - 路径 A（核心包）：类型层面强制、动作前确认、确认前重跑比对、业务语义披露。
 * - 路径 B（本包）：运行时强制、发请求那一刻确认、原始请求披露、覆盖面无死角。
 *
 * 判定策略是**默认拒绝**的：名单只用来表达例外，漏配一条规则的代价是多一次确认，
 * 而不是静默失去防护。
 *
 * 本包有副作用（会 patch 全局 `fetch` / `XMLHttpRequest` / `sendBeacon`），因此
 * 独立成包，核心包得以保持 `sideEffects: false`。
 *
 * @see docs/feat_20260728_请求拦截治理/design.md
 */

// ── 契约 ──────────────────────────────────────────────────────────
export type {
  InterceptedRequest,
  RequestChannel,
  Verdict,
  VerdictReason,
  EvaluatedVerdict,
  RequestMatcher,
  RequestRule,
  RequestDisclosure,
  InterceptionPolicy,
  AttributionPort,
  AuthorizationScope
} from './types'

// ── 判定策略 ──────────────────────────────────────────────────────
export {
  evaluateRequest,
  matchesRequest,
  findMatchingRule,
  compileUrlPattern,
  SAFE_METHODS,
  EVALUATION_ORDER
} from './policy'
export type { EvaluateOptions, FindMatchingRuleOptions } from './policy'

// ── 归属判定 ──────────────────────────────────────────────────────
export {
  createMaskAttribution,
  createStaticAttribution,
  DEFAULT_GRACE_MS
} from './attribution'
export type { MaskAttributionOptions } from './attribution'

// ── 已授权窗口 ────────────────────────────────────────────────────
export { createAuthorizationScope, runAuthorized } from './authorization'
export type { AuthorizedExecutionOptions } from './authorization'

// ── 拦截器 ────────────────────────────────────────────────────────
export { createInterceptor } from './interceptor'
export type {
  Interceptor,
  InterceptorOptions,
  ConfirmRequestHandler
} from './interceptor'

// ── 自由执行器 ────────────────────────────────────────────────────
export { defineExecutorTool } from './executor'
export type {
  ExecutorPort,
  ExecutorResult,
  ExecutorToolOptions
} from './executor'
