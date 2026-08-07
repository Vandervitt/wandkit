import type {
  ChatAssistantMessage,
  ChatCompletionChunk,
  ChatConfirmation,
  ChatEntry,
  ChatMessage,
  ChatState,
  ChatToolCall,
  ChatToolCallDelta
} from './protocol'

export interface ChatSessionOptions {
  /** 可注入的时钟，便于测试。缺省为真实时间。 */
  now?: () => number
  /** 会话起始的系统提示词等。它们进入 `toMessages()`，但不进入展示。 */
  initialMessages?: ChatMessage[]
}

type Listener = (state: ChatState) => void

/**
 * 无头会话状态机。
 *
 * **不碰 DOM，不发请求，不依赖 wandkit。** 它只做一件事：把 OpenAI 形态的消息与
 * 流式增量，变成渲染层能直接用的状态。因此它可以：
 *
 * - 接 `AgentRuntime`（见 `@wandkit/chat/bridge`）
 * - 也可以直接接接入方自己的后端——只要那边吐的是 OpenAI 形状
 * - 还可以配任意界面：自带的 Web Component、或接入方的 React / Vue 组件
 *
 * 内部同时维护两份数据：`messages` 是**线协议原文**（导出给下一轮请求用），
 * `entries` 是**展示投影**。不合并成一份，是因为渲染需要的东西（流式中、成败标记）
 * 一旦塞进消息，吐出去的就不再是标准 OpenAI 形状了。
 */
export class ChatSession {
  private readonly now: () => number
  private readonly listeners = new Set<Listener>()
  private messages: ChatMessage[] = []
  private entries: ChatEntry[] = []
  private status: ChatState['status'] = 'idle'
  private confirmation?: ChatConfirmation
  private error?: string
  /** 当前步骤的业务语言描述。见 {@link ChatState.progress}。 */
  private progress?: string
  private sequence = 0
  /** 正在流式接收的那条 assistant 条目在 `entries` 中的下标。 */
  private streamingIndex: number | null = null
  /**
   * 流式中累积的工具调用。
   *
   * 放在会话上而不是展示条目上：工具调用不进入展示（见 {@link toEntry}），挂在条目
   * 里会让渲染层重新有机会把它画出来，而那正是要消除的东西。
   */
  private streamingToolCalls: ChatToolCall[] = []
  /** 当前 Run 开始前的线协议与展示边界，用于用户中止时整轮回滚。 */
  private safePoint?: { messageCount: number, entryCount: number }

  constructor(options: ChatSessionOptions = {}) {
    this.now = options.now ?? Date.now
    options.initialMessages?.forEach(message => this.append(message))
  }

  /** 当前状态。每次返回新对象，便于框架做浅比较。 */
  get state(): ChatState {
    return {
      entries: this.entries.map(entry => ({ ...entry })),
      status: this.status,
      ...(this.confirmation ? { confirmation: { ...this.confirmation } } : {}),
      // 进度只在忙碌期间有意义。Run 结束还挂着「正在打开员工管理」，用户会以为它卡住了。
      ...(this.status === 'busy' && this.progress ? { progress: this.progress } : {}),
      ...(this.error ? { error: this.error } : {})
    }
  }

  /**
   * 订阅状态变化。
   *
   * @returns 退订函数。
   */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 用户发话。会清掉上一轮的错误，并把状态切到 `busy`。 */
  appendUser(content: string): void {
    this.error = undefined
    // 新的一轮从零开始：留着上一轮的末步描述，会在本轮第一个工具跑完前一直显示错的东西。
    this.progress = undefined
    this.append({ role: 'user', content })
  }

  /** 在新 Run 写入用户消息前记录可回滚边界。 */
  markSafePoint(): void {
    this.endStreaming()
    this.safePoint = {
      messageCount: this.messages.length,
      entryCount: this.entries.length
    }
  }

  /**
   * 丢弃安全点之后的整轮消息。
   *
   * 用户在工具执行中停止时，末尾可能只有 `assistant.tool_calls` 而没有配对的 `tool`
   * 消息；保留这种历史会让下一次 OpenAI 形态请求直接被协议层拒绝。
   */
  rollbackToSafePoint(): void {
    if (!this.safePoint) return
    this.endStreaming()
    this.messages.splice(this.safePoint.messageCount)
    this.entries.splice(this.safePoint.entryCount)
    this.safePoint = undefined
    this.status = 'idle'
    this.confirmation = undefined
    this.error = undefined
    this.progress = undefined
    this.streamingIndex = null
    this.streamingToolCalls = []
    this.emit()
  }

  /**
   * 追加一条完整消息。
   *
   * `system` 消息进入线协议但不进入展示——它是给模型的，不是给人看的。
   */
  append(message: ChatMessage): void {
    this.endStreaming()
    this.messages.push(cloneMessage(message))
    const entry = this.toEntry(message)
    if (entry) this.entries.push(entry)
    this.status = this.statusAfter(message)
    this.emit()
  }

  /**
   * 应用一个流式增量块。
   *
   * 首个带 `role: 'assistant'` 或任意内容的块会开一条新条目，后续块累积到同一条上，
   * 直到 `finish_reason` 到达。
   */
  applyChunk(chunk: ChatCompletionChunk): void {
    const choice = chunk.choices?.[0]
    if (!choice) return

    const { delta, finish_reason: finishReason } = choice
    if (delta && (delta.content !== undefined || delta.tool_calls || delta.role)) {
      this.ensureStreamingEntry()
      const index = this.streamingIndex as number
      const entry = this.entries[index]
      if (typeof delta.content === 'string') entry.content += delta.content
      if (delta.tool_calls) {
        this.streamingToolCalls = mergeToolCallDeltas(this.streamingToolCalls, delta.tool_calls)
      }
      this.status = 'busy'
    }

    if (finishReason) this.endStreaming()
    this.emit()
  }

  /** 挂起一次写操作，等待人工确认。 */
  requestConfirmation(confirmation: ChatConfirmation): void {
    this.confirmation = { ...confirmation }
    this.status = 'awaiting_confirmation'
    this.emit()
  }

  /**
   * 处理用户对确认卡片的决定。
   *
   * @returns ID 与当前待确认项匹配、决定已被接受时为 `true`。
   *   不匹配一律返回 `false`——上一个 Run 遗留在屏幕上的卡片回传的是过期 ID，
   *   放行它就等于用旧的同意批准了当前这次写入。
   */
  resolveConfirmation(
    confirmationId: string,
    _decision: 'approve' | 'reject'
  ): boolean {
    if (this.confirmation?.confirmationId !== confirmationId) return false
    this.confirmation = undefined
    // 批准与拒绝在会话这一侧都是 busy：批准后写入才刚要执行，拒绝后驱动方还要把
    // 这个决定回喂给模型。真正的分叉发生在驱动方，不在这里。
    this.status = 'busy'
    this.emit()
    return true
  }

  /** 记录一次失败，并把界面交还给用户。 */
  fail(message: string): void {
    this.endStreaming()
    this.error = message
    this.progress = undefined
    this.status = 'idle'
    this.emit()
  }

  /** 手动切换状态。驱动方在没有消息产生、但忙碌状态变化时使用。 */
  setStatus(status: ChatState['status']): void {
    this.status = status
    this.emit()
  }

  /** 清空会话，回到初始状态。 */
  clear(): void {
    this.messages = []
    this.entries = []
    this.status = 'idle'
    this.confirmation = undefined
    this.error = undefined
    this.progress = undefined
    this.streamingIndex = null
    this.streamingToolCalls = []
    this.safePoint = undefined
    this.emit()
  }

  /**
   * 导出为标准 OpenAI 消息数组，可直接作为下一轮请求的 `messages`。
   *
   * 返回深拷贝：调用方持有引用就能改动会话内部状态，那种污染极难从现象反推。
   */
  toMessages(): ChatMessage[] {
    return this.messages.map(cloneMessage)
  }

  /** 开一条流式条目，或复用正在流式中的那条。 */
  private ensureStreamingEntry(): void {
    if (this.streamingIndex !== null) return
    this.entries.push({
      id: `entry-${++this.sequence}`,
      role: 'assistant',
      content: '',
      streaming: true,
      at: this.now()
    })
    this.streamingIndex = this.entries.length - 1
  }

  /**
   * 结束流式，并把拼好的内容落成一条正式消息。
   *
   * 落成这一步不能省：`toMessages()` 导出的必须是完整消息，否则流式拼出来的那轮
   * 在下一次请求里会整个丢失。
   */
  private endStreaming(): void {
    if (this.streamingIndex === null) return
    const entry = this.entries[this.streamingIndex]
    delete entry.streaming
    const toolCalls = this.streamingToolCalls
    const message: ChatAssistantMessage = {
      role: 'assistant',
      content: entry.content || null
    }
    if (toolCalls.length) message.tool_calls = toolCalls
    this.messages.push(cloneMessage(message))
    // 只发了工具调用、一个字都没说的那一轮，条目会是个空气泡。留着它，一次多步任务
    // 就会在界面上排出十几个空白框。
    if (!entry.content) this.entries.splice(this.streamingIndex, 1)
    this.streamingIndex = null
    this.streamingToolCalls = []
    this.status = message.tool_calls ? 'busy' : 'idle'
  }

  /**
   * 把线协议消息投影成可渲染条目。
   *
   * **只有人看得懂的对话会投影出来。** 工具调用与工具结果留在 `messages` 里供下一轮
   * 请求使用，但不进入 `entries`——它们是执行细节，展示出来就是
   * `page_click_v1`、`✓ 已点击 [0]` 这种东西：内部函数名加元素下标，还会把唯一一句
   * 真正的回答淹没在十几条噪声中。执行进度改走 {@link progress}。
   *
   * @returns `undefined` 表示该消息不进入展示。
   */
  private toEntry(message: ChatMessage): ChatEntry | undefined {
    const base = { id: `entry-${++this.sequence}`, at: this.now() }
    if (message.role === 'system') return undefined
    if (message.role === 'user') {
      return { ...base, role: 'user', content: message.content }
    }
    if (message.role === 'assistant') {
      // 只发工具调用、没有话说的轮次不产生条目：那一轮对用户而言什么都没发生。
      if (!message.content) return undefined
      return { ...base, role: 'assistant', content: message.content }
    }
    // tool：不展示，但推进进度指示，让用户知道还在动、动到哪儿了。
    const parsed = parseToolContent(message.content)
    if (parsed.ok !== false) this.progress = parsed.message
    return undefined
  }

  /** 一条消息落地后，会话应处于什么状态。 */
  private statusAfter(message: ChatMessage): ChatState['status'] {
    if (message.role === 'user') return 'busy'
    if (message.role === 'system') return this.status
    // 带工具调用的 assistant 轮次还没结束，工具结果之后还有下一轮。
    if (message.role === 'assistant') {
      return message.tool_calls?.length ? 'busy' : 'idle'
    }
    return 'busy'
  }

  private emit(): void {
    const snapshot = this.state
    // 复制一份再派发：某个订阅者在回调里退订，不该影响本轮其余订阅者。
    ;[...this.listeners].forEach(listener => {
      try {
        listener(snapshot)
      } catch (_error) {
        // 订阅者自身的异常不得中断会话状态推进，更不该影响其他订阅者。
      }
    })
  }
}

/**
 * 把流式的工具调用碎片按 `index` 归位。
 *
 * `id` 与 `name` 通常只在首个片段出现，后续片段仅带 `arguments` 的一小段；而一轮里
 * 可能并行发起多个调用。没有 `index` 就无法把碎片放回正确的调用上。
 */
function mergeToolCallDeltas(
  existing: ChatToolCall[],
  deltas: ChatToolCallDelta[]
): ChatToolCall[] {
  const merged = existing.map(cloneToolCall)
  deltas.forEach(delta => {
    const slot = merged[delta.index] ?? {
      id: '',
      type: 'function' as const,
      function: { name: '', arguments: '' }
    }
    if (delta.id) slot.id = delta.id
    if (delta.function?.name) slot.function.name = delta.function.name
    if (delta.function?.arguments) slot.function.arguments += delta.function.arguments
    merged[delta.index] = slot
  })
  // 乱序到达的 index 会在数组里留空洞，压掉它们再交给渲染层。
  return merged.filter(Boolean)
}

/**
 * 解析 tool 消息的内容。
 *
 * 约定它是序列化的 `ToolResult`（`{ ok, message }`），但绝不强求——驱动方完全可能
 * 塞纯文本进来，那时原样展示即可，不能因为解析失败就丢掉这条结果。
 */
function parseToolContent(content: string): { message: string, ok?: boolean } {
  try {
    const parsed: unknown = JSON.parse(content)
    if (parsed && typeof parsed === 'object' && 'message' in parsed) {
      const record = parsed as { message?: unknown, ok?: unknown }
      return {
        message: typeof record.message === 'string' ? record.message : content,
        ...(typeof record.ok === 'boolean' ? { ok: record.ok } : {})
      }
    }
  } catch (_error) {
    // 不是 JSON，按纯文本处理。
  }
  return { message: content }
}

function cloneToolCall(call: ChatToolCall): ChatToolCall {
  return {
    id: call.id,
    type: call.type,
    function: { name: call.function.name, arguments: call.function.arguments }
  }
}

function cloneMessage(message: ChatMessage): ChatMessage {
  if (message.role === 'assistant') {
    return {
      role: 'assistant',
      content: message.content,
      ...(message.tool_calls ? { tool_calls: message.tool_calls.map(cloneToolCall) } : {})
    }
  }
  if (message.role === 'tool') {
    return {
      role: 'tool',
      content: message.content,
      tool_call_id: message.tool_call_id
    }
  }
  return { role: message.role, content: message.content }
}
