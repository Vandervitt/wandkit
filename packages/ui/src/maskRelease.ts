/** 遮罩的最小形状，便于宿主传入自己的实现。 */
export interface ReleasableMask {
  arm(): void
  disarm(): void
  readonly armed: boolean
}

/** 当前处于让位状态的遮罩，及其嵌套深度。 */
const released = new WeakMap<ReleasableMask, number>()

/**
 * 遮罩让位的时机。
 *
 * **必须在卡片出现时就让位，而不是等用户点击。** 遮罩的 z-index 压过宿主放置卡片的
 * 容器，不先解除的话点击根本传不到卡片上——包住点击回调是没用的，那个回调压根不会
 * 被触发。真实接入中先踩了这个坑，才找到正确时序。
 *
 * 因此本模块提供两种用法：
 *
 * - {@link createMaskReleaser}——卡片出现/消失时调用（**推荐**）
 * - {@link withMaskReleased}——包住一段本就能拿到控制权的异步流程
 */

/**
 * 在确认期间让遮罩让位，结束后恢复。
 *
 * **为什么需要它**：遮罩的 z-index 压过宿主的一切弹层——这是归属判定的前提。但宿主
 * 放置确认卡片的容器同样在遮罩之下，于是卡片弹出来却点不动：Run 卡在
 * `awaiting_confirmation`，而用户完全看不出为什么。真实接入中实测踩到过。
 *
 * **为什么不能靠提高卡片的 z-index**：卡片在宿主容器的层叠上下文内，它的层级只在
 * 那个容器内部比较。容器本身的层级由宿主决定，包内改不了。
 *
 * 遮罩让位才是对的方向——它的职责是挡住用户**操作页面**，而确认卡片恰恰**需要**
 * 用户点击。两者本就不该同时生效。
 *
 * @example
 * card.addEventListener('approve', async event => {
 *   await withMaskReleased(mask, () => runtime.confirm(event.detail.confirmationId))
 * })
 */
export async function withMaskReleased<T>(
  mask: ReleasableMask | undefined,
  run: () => Promise<T>
): Promise<T> {
  if (!mask) return run()

  const depth = released.get(mask) ?? 0
  // 只有最外层需要记住「原本是否武装」并负责恢复：内层若也恢复，外层的确认还没
  // 结束遮罩就回来了，卡片又变得点不动。
  const shouldRearm = depth === 0 && mask.armed
  released.set(mask, depth + 1)
  if (shouldRearm) mask.disarm()

  try {
    return await run()
  } finally {
    const next = (released.get(mask) ?? 1) - 1
    if (next <= 0) released.delete(mask)
    else released.set(mask, next)
    // 必须在 finally 里：确认过程抛异常却没恢复遮罩，Agent 的后续动作就失去了
    // 归属判定的依据。
    if (shouldRearm) mask.arm()
  }
}


/**
 * 按确认卡片的生命周期让遮罩让位。
 *
 * 用法是在会话状态订阅里调用——有待确认项时让位，没有时恢复：
 *
 * @example
 * const release = createMaskReleaser(mask)
 *
 * session.subscribe(state => {
 *   release(Boolean(state.confirmation))
 *   // …渲染卡片
 * })
 *
 * @returns 一个开关函数。传 `true` 让位、`false` 恢复；重复调用是幂等的。
 */
export function createMaskReleaser(
  mask: ReleasableMask | undefined
): (confirming: boolean) => void {
  /** 让位前遮罩是否武装——决定结束后要不要恢复。 */
  let wasArmed = false
  let releasing = false

  return confirming => {
    if (!mask) return
    if (confirming) {
      if (releasing) return
      releasing = true
      wasArmed = mask.armed
      if (wasArmed) mask.disarm()
      return
    }
    if (!releasing) return
    releasing = false
    // 原本没武装就不恢复：用户自己触发的确认不该凭空出现一层遮罩。
    if (wasArmed) mask.arm()
  }
}
