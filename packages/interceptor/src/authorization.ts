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
  /**
   * 每个 token 当前的开窗次数。
   *
   * 按 token 计数而非只维护一个总数，是为了让 `end` 一个从未 `begin` 过的 token
   * 成为空操作——否则一次多余的 `end` 会把别人的窗口关掉。
   */
  const open = new Map<string, number>()

  return {
    begin(token) {
      open.set(token, (open.get(token) ?? 0) + 1)
    },
    end(token) {
      const count = open.get(token)
      if (count === undefined) return
      // 减到 0 就删掉：留着 0 会让 `open.size` 永远不归零。
      if (count <= 1) open.delete(token)
      else open.set(token, count - 1)
    },
    isAuthorized() {
      return open.size > 0
    }
  }
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
  options: AuthorizedExecutionOptions,
  run: () => Promise<T>
): Promise<T> {
  options.scope.begin(options.token)
  try {
    return await run()
  } finally {
    // 必须在 finally 里：`run` 抛异常却没关窗口，后续所有 Agent 请求都会被无条件
    // 放行，闸门就此静默失效——而且不会有任何报错提示它已经失效了。
    options.scope.end(options.token)
  }
}
