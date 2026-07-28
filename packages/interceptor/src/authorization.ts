import type { AuthorizationScope } from './types'

/**
 * 已授权窗口。
 *
 * 路径 A 的工具在用户确认后执行 `execute`，其内部发出的请求会被拦截器再次捕获。
 * 不处理的话，**每给一个动作写声明式工具，反而多挨一次确认**——那等于惩罚正确
 * 做法，接入方很快就会绕开工具直接写代码。因此这是必做项，不是优化。
 *
 * 用计数而非布尔：一个工具的 `execute` 内部可能再触发嵌套的已授权操作，
 * 布尔量会被内层的 `end` 提前清掉，导致外层剩余请求重新开始弹卡片。
 */
export function createAuthorizationScope(): AuthorizationScope {
  throw new Error('Not implemented: 阶段 3')
}

/**
 * 把已授权窗口接到核心包的写工具执行链路上。
 *
 * 由宿主在构造 `ActionRouter` 时接线：确认通过、真正执行前 `begin`，无论成败
 * `end`。必须放在 `finally` 里——`execute` 抛异常却没关窗口，后续所有 Agent 请求
 * 都会被无条件放行，闸门就此静默失效。
 */
export interface AuthorizedExecutionOptions {
  scope: AuthorizationScope
  /** 通常用确认项的 `confirmationId`，便于与 trace 对齐。 */
  token: string
}

export async function runAuthorized<T>(
  _options: AuthorizedExecutionOptions,
  _run: () => Promise<T>
): Promise<T> {
  throw new Error('Not implemented: 阶段 3')
}
