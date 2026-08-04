import type { ConfirmationRow } from 'wandkit'

/** 请求走的是哪条浏览器通道。决定它能不能被挂起，见 {@link Interceptor}。 */
export type RequestChannel = 'fetch' | 'xhr' | 'beacon' | 'form'

/**
 * 被拦下、尚未发出的请求。
 *
 * 这是判定与披露共用的唯一事实来源：判定策略按它匹配规则，确认卡片按它渲染
 * `rawRequest`。刻意保持为纯数据，不持有底层 `Request` / `XMLHttpRequest` 实例——
 * 规则的 `when()` 与 `describe()` 由接入方编写，不该拿到能改写在途请求的句柄。
 */
export interface InterceptedRequest {
  /** 本次拦截的关联 ID，贯穿判定、确认与 trace。 */
  id: string
  method: string
  /** 已解析为绝对形式，避免规则要同时处理相对与绝对两种写法。 */
  url: string
  headers: Readonly<Record<string, string>>
  /**
   * 已解析的请求体。JSON 请求为对象，其余保持原始形态。
   * 不可信：它可能来自模型编造的参数。
   */
  body?: unknown
  channel: RequestChannel
  timestamp: number
}

/**
 * 判定结论。
 *
 * `confirm` 携带风险等级而非文案——等级参与调度（`destructive` 会让卡片更重、
 * 原始请求默认展开），文案则一律由 `WandkitMessages` 提供。这与核心包
 * 「绝不基于文案分支」的原则一致。
 */
export type Verdict =
  | { action: 'allow', ruleId?: string }
  | { action: 'confirm', risk: 'write' | 'destructive', ruleId?: string }
  | { action: 'deny', reason: string, ruleId?: string }

/** 判定为何是这个结论。仅用于 trace 与排障，不参与控制流。 */
export type VerdictReason =
  | 'not_agent_initiated'
  | 'pre_authorized'
  | 'safe_method'
  | 'danger_list'
  | 'allow_list'
  | 'default_deny'

/** 带出处的判定结果。 */
export interface EvaluatedVerdict {
  verdict: Verdict
  reason: VerdictReason
}

/** 规则匹配条件。三项都给出时为合取。 */
export interface RequestMatcher {
  /** 缺省匹配任意方法。大小写不敏感。 */
  method?: string | string[]
  /** glob（支持 `*` 与 `:param`）或 RegExp。缺省匹配任意 URL。 */
  url?: string | RegExp
  /**
   * 进一步按请求内容判定，例如仅当 `{ force: true }` 才算高危。
   *
   * 必须是纯函数：判定期间会被调用，抛异常按「不匹配」处理，绝不能让一条写坏的
   * 规则把整个闸门顶掉。
   */
  when?(request: InterceptedRequest): boolean
}

/**
 * 把原始请求翻译成人话。
 *
 * 不提供时卡片只能展示 `method + url + body`——够用但不好懂。这是路径 B 相对
 * 声明式工具的主要能力缺口，因此设计成**可选增强**：不写也能治理，写了体验更好，
 * 但绝不重新变成「必须逐个声明」。
 */
export interface RequestDisclosure {
  title: string
  rows: ConfirmationRow[]
  impact?: string
}

/** 一条判定规则。 */
export interface RequestRule {
  /** 稳定标识，会进 trace，便于统计哪条规则在起作用。 */
  id: string
  match: RequestMatcher
  describe?(request: InterceptedRequest): Promise<RequestDisclosure>
}

/**
 * 判定策略。
 *
 * 设计要点是**默认拒绝**：`danger` 与 `allow` 都只用来表达例外，兜底行为由
 * {@link defaultForUnsafeMethods} 决定。漏配一条规则的代价是多一次确认，
 * 而不是静默失去防护——这正是它与黑名单方案的根本区别。
 */
export interface InterceptionPolicy {
  /**
   * 名单 B：高危动作，升级为 `destructive`。
   *
   * 判定时**先于** {@link allow} 匹配。放行规则常写成宽泛通配，若让它先命中，
   * 一条粗糙的规则就可能把高危动作一并放过。危险优先于放行。
   */
  danger?: RequestRule[]
  /** 名单 A：已知安全的写（如查询伪装成 POST），直接放行。 */
  allow?: RequestRule[]
  /** 非安全方法的兜底判定，缺省 `'confirm'`。 */
  defaultForUnsafeMethods?: 'confirm' | 'deny'
  /** 安全方法（GET/HEAD/OPTIONS/TRACE）的判定，缺省 `'allow'`。 */
  defaultForSafeMethods?: 'allow' | 'confirm'
}

/**
 * 归属判定：这次请求是 Agent 发起的，还是用户自己点的？
 *
 * 不区分的话，用户手动点删除也会弹确认，产品直接不可用。
 *
 * 默认实现绑定 `InteractionMask`——遮罩武装期间用户无法操作，因此窗口内的请求
 * 必然来自 Agent。这是**排除法**，用于绕开「跨异步边界传递发起方上下文」这个
 * 浏览器里没有可靠解法的问题。
 */
export interface AttributionPort {
  isAgentActive(): boolean
}

/**
 * 已授权窗口：路径 A 的工具在用户确认后执行期间，其请求不再重复确认。
 *
 * 没有它，每给一个动作写声明式工具反而多挨一次确认，等于惩罚正确做法。
 *
 * 已知取舍：窗口是粗粒度的，窗口内该工具发出的任何请求都会放行。这在路径 A 的
 * 信任模型下可接受（工具是声明过、评审过的代码），但**不防御「工具行为与声明
 * 不符」**这种情况。
 */
export interface AuthorizationScope {
  begin(token: string): void
  end(token: string): void
  isAuthorized(): boolean
}
