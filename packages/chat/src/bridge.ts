import type { ChatConfirmation } from './protocol'
import type { ChatSession } from './session'

/**
 * 桥接层：把 `AgentRuntime` 的事件翻译成会话状态，把界面动作翻译成运行时调用。
 *
 * **本文件不 import `toolairlock`。** 那会让整个 chat 包硬依赖核心运行时，与
 * 「可单独使用」直接冲突。改用最小的鸭子类型描述运行时——TypeScript 的结构化类型
 * 让真正的 `AgentRuntime` 可以直接传进来，无需任何适配。
 */

/** 运行时推给界面的事件。与核心的 `RuntimeUiEvent` 结构兼容。 */
export interface RuntimeUiEventLike {
  type: 'state' | 'assistant' | 'confirmation' | 'tool_result' | 'clear'
  snapshot?: { runId: string, traceId: string, status: string }
  content?: string | null
  confirmation?: ChatConfirmation
  toolCallId?: string
  result?: { ok: boolean, message: string }
  cancelled?: boolean
  /** 终态原因。核心当前放在 trace 里，宿主转发时可一并带上。 */
  stopReason?: string
}

/** 运行时暴露给界面的操作。与 `AgentRuntime` 的同名方法兼容。 */
export interface RuntimeLike {
  start(userInput: string): Promise<unknown>
  confirm(confirmationId: string): Promise<unknown>
  cancel(confirmationId: string): Promise<unknown>
  stop(): void
}

export interface ConnectRuntimeOptions {
  /**
   * 注册事件回调。
   *
   * 之所以要宿主传进来，是因为 `AgentRuntime` 的事件出口是构造时注入的 `emit`
   * 回调，运行时本身没有 `on()` 之类的订阅接口。宿主在自己的 `emit` 里转调即可。
   */
  onEvent(handler: (event: RuntimeUiEventLike) => void): void
}

/** 界面可以对会话做的事。 */
export interface ChatControls {
  /** 发一句话。同时写入会话与运行时。 */
  send(text: string): Promise<void>
  approve(confirmationId: string): Promise<void>
  reject(confirmationId: string): Promise<void>
  stop(): void
  /** 停止接收运行时事件。 */
  dispose(): void
}

/** Run 处于这些状态时，界面应当交还给用户。 */
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled'])

/**
 * 把会话接到运行时上。
 *
 * @returns 界面用的操作集合。
 */
export function connectRuntime(
  session: ChatSession,
  runtime: RuntimeLike,
  options: ConnectRuntimeOptions
): ChatControls {
  let disposed = false

  options.onEvent(event => {
    if (disposed) return
    switch (event.type) {
      case 'assistant':
        // 有工具调用的轮次 content 为 null，那通常是思维链，不该展示。
        if (event.content) session.append({ role: 'assistant', content: event.content })
        break
      case 'tool_result':
        if (event.toolCallId && event.result) {
          session.append({
            role: 'tool',
            tool_call_id: event.toolCallId,
            content: JSON.stringify(event.result)
          })
        }
        break
      case 'confirmation':
        if (event.confirmation) session.requestConfirmation(event.confirmation)
        break
      case 'state':
        applyRunStatus(session, event)
        break
      case 'clear':
        session.clear()
        break
    }
  })

  /**
   * 统一包住运行时调用。
   *
   * 运行时会为「已有 Run 正在执行」「没有待确认操作」这类情况抛错。不接住的话，
   * 界面会停在 busy 上再也回不来——用户既看不到原因，也没法重试。
   */
  const guard = async (action: () => Promise<unknown>): Promise<void> => {
    try {
      await action()
    } catch (error) {
      session.fail(error instanceof Error ? error.message : String(error))
    }
  }

  return {
    async send(text) {
      session.appendUser(text)
      await guard(() => runtime.start(text))
    },
    async approve(confirmationId) {
      // 先过会话的 ID 校验：过期卡片回传的 ID 不该打到运行时上。
      if (!session.resolveConfirmation(confirmationId, 'approve')) return
      await guard(() => runtime.confirm(confirmationId))
    },
    async reject(confirmationId) {
      if (!session.resolveConfirmation(confirmationId, 'reject')) return
      await guard(() => runtime.cancel(confirmationId))
    },
    stop() {
      runtime.stop()
    },
    dispose() {
      disposed = true
    }
  }
}

function applyRunStatus(session: ChatSession, event: RuntimeUiEventLike): void {
  const status = event.snapshot?.status
  if (!status) return
  if (status === 'awaiting_confirmation') return
  if (!TERMINAL_STATUSES.has(status)) {
    session.setStatus('busy')
    return
  }
  if (status === 'failed' && event.stopReason) {
    session.fail(event.stopReason)
    return
  }
  session.setStatus('idle')
}
