import type {
  EvaluatedVerdict,
  InterceptedRequest,
  InterceptionPolicy,
  RequestMatcher,
  RequestRule
} from './types'

/**
 * 无副作用的 HTTP 方法。
 *
 * 按 RFC 7231 的 safe methods，外加 TRACE。判定里它们直接放行——不是因为信任
 * 调用方，而是因为它们本就不该改变服务端状态；若某个 GET 实际上会写，那是后端
 * 的契约问题，前端闸门修不了，也不该假装能修。
 */
export const SAFE_METHODS: readonly string[] = ['GET', 'HEAD', 'OPTIONS', 'TRACE']

/**
 * 判定顺序。顺序本身是安全语义，**不可调整**。
 *
 * 完整理由见 `docs/feat_20260728_请求拦截治理/design.md` §5.1，其中两条最关键：
 *
 * - `danger_list` 必须先于 `allow_list`：放行规则常写成宽泛通配，让它先命中就可能
 *   把高危动作一并放过。
 * - 末位是 `default_deny` 而非「放行」：这是与黑名单方案的根本区别，漏配规则的
 *   代价是多一次确认，而不是静默失去防护。
 */
export const EVALUATION_ORDER = [
  'not_agent_initiated',
  'pre_authorized',
  'safe_method',
  'danger_list',
  'allow_list',
  'default_deny'
] as const

export interface EvaluateOptions {
  request: InterceptedRequest
  policy: InterceptionPolicy
  isAgentActive: boolean
  isPreAuthorized: boolean
}

/**
 * 按 {@link EVALUATION_ORDER} 判定一个请求。
 *
 * 纯函数：不碰网络、不碰 DOM、不读全局，因此判定顺序可以被完整单测覆盖，
 * 而不必先把浏览器 API patch 起来。
 *
 * @returns 结论与出处。出处只进 trace，不参与控制流。
 */
export function evaluateRequest(_options: EvaluateOptions): EvaluatedVerdict {
  throw new Error('Not implemented: 阶段 1')
}

/**
 * 判断请求是否命中匹配条件。
 *
 * `when()` 抛异常时按**不匹配**处理：一条写坏的规则不该把整个闸门顶掉。但对
 * `danger` 规则而言，「不匹配」意味着降级，因此实现时必须把异常记入 trace，
 * 不能真的静默。
 */
export function matchesRequest(
  _request: InterceptedRequest,
  _matcher: RequestMatcher
): boolean {
  throw new Error('Not implemented: 阶段 1')
}

/** 返回首条命中的规则，用于把 `ruleId` 带进判定结果。 */
export function findMatchingRule(
  _request: InterceptedRequest,
  _rules: readonly RequestRule[] | undefined
): RequestRule | undefined {
  throw new Error('Not implemented: 阶段 1')
}

/**
 * 把 glob（`*` 与 `:param`）编译成正则。
 *
 * 单独抽出来是因为它是规则作者最容易踩坑的地方：`/api/*` 是否跨 `/` 段匹配，
 * 直接决定一条放行规则的实际覆盖面，必须有独立测试钉死语义。
 */
export function compileUrlPattern(_pattern: string): RegExp {
  throw new Error('Not implemented: 阶段 1')
}
