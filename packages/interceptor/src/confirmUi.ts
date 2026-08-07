import { CONFIRM_CARD_TAG, type ConfirmCardData } from '@wandkit/ui'
import type { ConfirmRequestHandler } from './interceptor'
import type { InterceptedRequest } from './types'

/**
 * 把拦截器的确认请求接到 `@wandkit/ui` 的确认卡片上。
 *
 * 单独成一个文件，是因为**拦截器本身刻意不依赖 UI 包**：它要能在没有界面的场景下
 * 单独治理宿主代码。这层是可选接线，只有确实要用现成卡片时才引入。
 *
 * 卡片需要 `confirmationId` 与 `rawRequest`，两者都不在 `RequestDisclosure` 里——
 * 前者由本层生成，后者直接取自被拦下的请求。
 */

/** 遮罩的最小形状。与 `InteractionMask` 结构兼容。 */
export interface MaskLike {
  arm(): void
  disarm(): void
  readonly armed: boolean
}

export interface ConfirmCardHandlerOptions {
  /** 卡片挂载点。宿主决定它在页面上的位置。 */
  host: HTMLElement
  /**
   * 取消当前及排队中的全部确认。常由宿主在卸载或销毁时触发；取消一律按拒绝处理。
   */
  signal?: AbortSignal
  /**
   * 交互遮罩。
   *
   * 给了就在确认期间自动解除、决定后恢复——遮罩的作用是挡住用户操作页面，而确认
   * 卡片恰恰**需要**用户点击，不解除就点不到自己的闸门。
   */
  mask?: MaskLike
}

/**
 * 创建一个基于确认卡片的 {@link ConfirmRequestHandler}。
 *
 * 多个请求同时命中确认时**逐个排队**，不同时堆两张卡片——堆在一起会让人分不清自己
 * 批的是哪一个，审计记录也说不清。这与核心包 `ConfirmationManager` 的取舍一致。
 */
export function createConfirmCardHandler(
  options: ConfirmCardHandlerOptions
): ConfirmRequestHandler {
  /** 串行化队列。前一张卡片处理完，下一张才渲染。 */
  let queue: Promise<unknown> = Promise.resolve()
  let sequence = 0

  return input => {
    const run = async (): Promise<boolean> => {
      if (options.signal?.aborted) return false
      const confirmationId = `interceptor-${++sequence}`
      const card = options.host.ownerDocument.createElement(CONFIRM_CARD_TAG) as
        HTMLElement & { data: ConfirmCardData }

      card.data = {
        confirmationId,
        title: input.disclosure?.title ?? `${input.request.method} ${input.request.url}`,
        rows: input.disclosure?.rows ?? [],
        ...(input.disclosure?.impact ? { impact: input.disclosure.impact } : {}),
        risk: input.risk,
        rawRequest: toRawRequest(input.request)
      }

      // 遮罩挡住的是「用户操作页面」，而这张卡片需要用户点。不解除就点不到闸门本身。
      const shouldRearm = options.mask?.armed === true
      options.mask?.disarm()
      options.host.appendChild(card)

      let removeAbortListener = (): void => undefined
      try {
        return await new Promise<boolean>(resolve => {
          let settled = false
          const settle = (approved: boolean): void => {
            if (settled) return
            settled = true
            resolve(approved)
          }
          const decide = (approved: boolean) => (event: Event) => {
            const detail = (event as CustomEvent<{ confirmationId?: string }>).detail
            // ID 校验让过期卡片变得无害：上一次遗留在屏幕上的卡片回传的是旧 ID，
            // 放行它等于用旧的同意批准这一次。
            if (detail?.confirmationId !== confirmationId) return
            settle(approved)
          }
          card.addEventListener('approve', decide(true))
          card.addEventListener('reject', decide(false))
          if (options.signal) {
            const onAbort = (): void => settle(false)
            options.signal.addEventListener('abort', onAbort, { once: true })
            removeAbortListener = () => options.signal?.removeEventListener('abort', onAbort)
            if (options.signal.aborted) onAbort()
          }
        })
      } finally {
        removeAbortListener()
        card.remove()
        if (shouldRearm) options.mask?.arm()
      }
    }

    // 排进队列，并保证前一张的失败不会卡死后面的。
    const pending = queue.then(run, run)
    queue = pending.catch(() => undefined)
    return pending
  }
}

/** 把被拦下的请求投影成卡片的原始请求区块。 */
function toRawRequest(request: InterceptedRequest): ConfirmCardData['rawRequest'] {
  return {
    method: request.method,
    url: request.url,
    ...(request.body === undefined ? {} : { body: request.body })
  }
}
