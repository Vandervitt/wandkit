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
 * 完整理由见 `docs/feat_20260728_请求拦截治理/design.md` §5.1，其中三条最关键：
 *
 * - `danger_list` 必须先于 `allow_list`：放行规则常写成宽泛通配，让它先命中就可能
 *   把高危动作一并放过。
 * - `danger_list` 还必须先于 `safe_method`：GET 无副作用不等于安全，导出类接口会
 *   外泄数据。安全方法若先短路，这类请求将永远无法被名单拦下。
 * - 末位是 `default_deny` 而非「放行」：这是与黑名单方案的根本区别，漏配规则的
 *   代价是多一次确认，而不是静默失去防护。
 */
export const EVALUATION_ORDER = [
  'not_agent_initiated',
  'pre_authorized',
  'danger_list',
  'safe_method',
  'allow_list',
  'default_deny'
] as const

export interface EvaluateOptions {
  request: InterceptedRequest
  policy: InterceptionPolicy
  isAgentActive: boolean
  isPreAuthorized: boolean
  /**
   * 规则的 `when()` 抛异常时回调。
   *
   * 异常本身按「朝更需要确认的方向倒」处理（见 {@link evaluateRequest}），但绝不能
   * 静默——一条一直抛错的规则会持续偏移判定结果，宿主必须能看见它。
   */
  onRuleError?(ruleId: string, error: unknown): void
}

/**
 * 按 {@link EVALUATION_ORDER} 判定一个请求。
 *
 * 纯函数：不碰网络、不碰 DOM、不读全局，因此判定顺序可以被完整单测覆盖，
 * 而不必先把浏览器 API patch 起来。
 *
 * @returns 结论与出处。出处只进 trace，不参与控制流。
 */
export function evaluateRequest(options: EvaluateOptions): EvaluatedVerdict {
  const { request, policy, isAgentActive, isPreAuthorized, onRuleError } = options

  if (!isAgentActive) {
    return { verdict: { action: 'allow' }, reason: 'not_agent_initiated' }
  }
  if (isPreAuthorized) {
    return { verdict: { action: 'allow' }, reason: 'pre_authorized' }
  }

  // 危险名单先于安全方法与放行名单，理由见 EVALUATION_ORDER。
  const danger = findMatchingRule(request, policy.danger, {
    onRuleError,
    // 危险规则求值出错时按命中处理：宁可多问一次，也不能因为规则写坏了就放过高危动作。
    onError: 'match'
  })
  if (danger) {
    return {
      verdict: { action: 'confirm', risk: 'destructive', ruleId: danger.id },
      reason: 'danger_list'
    }
  }

  if (SAFE_METHODS.includes(request.method.toUpperCase())) {
    return policy.defaultForSafeMethods === 'confirm'
      ? { verdict: { action: 'confirm', risk: 'write' }, reason: 'safe_method' }
      : { verdict: { action: 'allow' }, reason: 'safe_method' }
  }

  const allowed = findMatchingRule(request, policy.allow, {
    onRuleError,
    // 放行规则求值出错时按未命中处理，落到默认拒绝——同样是朝「更需要确认」倒。
    onError: 'skip'
  })
  if (allowed) {
    return {
      verdict: { action: 'allow', ruleId: allowed.id },
      reason: 'allow_list'
    }
  }

  return policy.defaultForUnsafeMethods === 'deny'
    ? {
      verdict: { action: 'deny', reason: 'Blocked by default-deny policy.' },
      reason: 'default_deny'
    }
    : { verdict: { action: 'confirm', risk: 'write' }, reason: 'default_deny' }
}

/**
 * 判断请求是否命中匹配条件。
 *
 * `when()` 抛异常时按**不匹配**处理：一条写坏的规则不该把整个闸门顶掉。但对
 * `danger` 规则而言，「不匹配」意味着降级，因此实现时必须把异常记入 trace，
 * 不能真的静默。
 */
export function matchesRequest(
  request: InterceptedRequest,
  matcher: RequestMatcher
): boolean {
  return matchesMethod(request, matcher) &&
    matchesUrl(request, matcher) &&
    (matcher.when === undefined || matcher.when(request))
}

function matchesMethod(
  request: InterceptedRequest,
  matcher: RequestMatcher
): boolean {
  if (matcher.method === undefined) return true
  const method = request.method.toUpperCase()
  const expected = Array.isArray(matcher.method) ? matcher.method : [matcher.method]
  return expected.some(candidate => candidate.toUpperCase() === method)
}

/**
 * 决定拿请求 URL 的哪一部分去比对。
 *
 * 以 `/` 开头的模式只比 `pathname`：绝大多数规则不关心 origin，也不该因为多了个
 * query 就漏配。需要按 query 判定时用 `when()`，那里能拿到完整 URL。
 *
 * 带协议的模式比完整 URL，用于区分不同后端（例如只放行自家域名）。
 */
function matchesUrl(request: InterceptedRequest, matcher: RequestMatcher): boolean {
  if (matcher.url === undefined) return true
  if (matcher.url instanceof RegExp) return testRegExp(matcher.url, request.url)

  const target = matcher.url.startsWith('/')
    ? pathnameOf(request.url)
    : request.url
  return compileUrlPattern(matcher.url).test(target)
}

function testRegExp(pattern: RegExp, value: string): boolean {
  // g/y 的 test() 会读写 lastIndex；规则判定必须独立于上一次请求留下的游标。
  const candidate = pattern.global || pattern.sticky
    ? new RegExp(pattern.source, pattern.flags)
    : pattern
  return candidate.test(value)
}

function pathnameOf(url: string): string {
  try {
    return new URL(url).pathname
  } catch (_error) {
    // 相对 URL 或畸形 URL：退回到去掉 query / hash 的原串。
    return url.split(/[?#]/)[0]
  }
}

export interface FindMatchingRuleOptions {
  onRuleError?(ruleId: string, error: unknown): void
  /**
   * `when()` 抛异常时如何处置该规则。
   *
   * 两个方向都指向「朝更需要确认倒」：危险名单用 `'match'`（宁可多问一次），
   * 放行名单用 `'skip'`（不因规则写坏就放行）。
   */
  onError?: 'match' | 'skip'
}

/** 返回首条命中的规则，用于把 `ruleId` 带进判定结果。 */
export function findMatchingRule(
  request: InterceptedRequest,
  rules: readonly RequestRule[] | undefined,
  options: FindMatchingRuleOptions = {}
): RequestRule | undefined {
  if (!rules) return undefined
  return rules.find(rule => {
    try {
      return matchesRequest(request, rule.match)
    } catch (error) {
      options.onRuleError?.(rule.id, error)
      return options.onError === 'match'
    }
  })
}

/**
 * 把 glob（`*` 与 `:param`）编译成正则。
 *
 * 单独抽出来是因为它是规则作者最容易踩坑的地方：`/api/*` 是否跨 `/` 段匹配，
 * 直接决定一条放行规则的实际覆盖面，必须有独立测试钉死语义。
 */
export function compileUrlPattern(pattern: string): RegExp {
  const source = pattern
    // 先切出通配符，其余片段整体转义，避免 `.` `?` 这类元字符被当成通配。
    .split(/(\*\*|\*|:[A-Za-z_][A-Za-z0-9_]*)/)
    .map(segment => {
      if (segment === '**') return '.*'
      // 单 `*` 与 `:param` 都不跨越 `/`：这决定了放行规则的真实覆盖面。
      // 若单 `*` 跨段，一条 `/api/*` 就等于放行 `/api` 下的一切。
      if (segment === '*') return '[^/]*'
      if (/^:[A-Za-z_][A-Za-z0-9_]*$/.test(segment)) return '[^/]+'
      return escapeRegExp(segment)
    })
    .join('')
  // 整体锚定：不锚定的话 `/api` 会命中 `/api/anything`，宽泛放行规则会失控。
  return new RegExp(`^${source}$`)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
