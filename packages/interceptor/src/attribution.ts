import type { AttributionPort } from './types'

/**
 * Agent 动作结束后仍按 Agent 归属的宽限时长。
 *
 * Agent 的操作常触发防抖保存一类的延迟请求，它们在遮罩解除之后才真正发出；不留
 * 宽限期，这些写入会被当成用户自己的操作直接放行。
 *
 * 取值偏小是刻意的：窗口越长，越可能把用户紧接着的真实操作误判成 Agent 的，
 * 那会让他在自己点击后莫名收到一张确认卡片。
 */
export const DEFAULT_GRACE_MS = 500

export interface MaskAttributionOptions {
  /** 遮罩是否处于武装状态，通常直接接 `InteractionMask.armed`。 */
  isMaskArmed(): boolean
  /** 缺省 {@link DEFAULT_GRACE_MS}。 */
  graceMs?: number
  now?(): number
}

/**
 * 基于交互遮罩的归属判定。
 *
 * 依据是排除法：遮罩武装期间用户点不动页面，因此这段时间里发出的请求只可能来自
 * Agent。这样就绕开了「跨异步边界传递发起方上下文」——那件事在浏览器里没有可靠
 * 解法，链路染色一类的方案都要靠时间窗口妥协，反而更脆。
 *
 * 因此遮罩不是装饰：关掉它，归属判定就失去依据，整个拦截方案的前提也就没了。
 */
export function createMaskAttribution(
  _options: MaskAttributionOptions
): AttributionPort {
  throw new Error('Not implemented: 阶段 3')
}

/**
 * 恒定归属。仅供测试与「整页都归 Agent」的极端场景使用。
 *
 * 生产环境传 `true` 等于放弃归属判定，用户的每一次手动写操作都会弹确认。
 */
export function createStaticAttribution(active: boolean): AttributionPort {
  return { isAgentActive: () => active }
}
