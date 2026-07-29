/**
 * UI 与驱动方之间的线协议：OpenAI chat-completions 形态。
 *
 * 选它做边界有三个理由：
 *
 * 1. **主流厂商与网关都认它**——接入方把自己的后端摆在任意模型前面，UI 这侧不必改；
 * 2. **核心包已经用它**（`toolairlock` 的 `LlmMessage` 就是这套形状），因此接上
 *    Runtime 时不需要任何格式转换；
 * 3. **可脱离核心单独使用**——只要驱动方能吐出这个形状，UI 就能跑，哪怕根本没有
 *    toolairlock 运行时。
 *
 * 本文件刻意**不从 `toolairlock` 导入**类型：那会让本包硬依赖核心，与「可单独使用」
 * 相矛盾。两边是结构性兼容的（TypeScript 的结构化类型让它们可以直接互传），
 * 一致性由 `protocol.spec.ts` 的编译期断言守住。
 */

/** 模型请求的一次工具调用。 */
export interface ChatToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    /** JSON 编码的参数。不可信：展示前需当作纯文本处理。 */
    arguments: string
  }
}

export interface ChatSystemMessage {
  role: 'system'
  content: string
}

export interface ChatUserMessage {
  role: 'user'
  content: string
}

export interface ChatAssistantMessage {
  role: 'assistant'
  /** 仅发出工具调用时为 null 或空串。 */
  content: string | null
  tool_calls?: ChatToolCall[]
}

/** 单次工具调用的结果，与发起它的 `tool_call_id` 配对。 */
export interface ChatToolMessage {
  role: 'tool'
  content: string
  tool_call_id: string
}

export type ChatMessage =
  | ChatSystemMessage
  | ChatUserMessage
  | ChatAssistantMessage
  | ChatToolMessage

// ── 流式增量 ────────────────────────────────────────────────────────

/**
 * 流式 delta 中的工具调用片段。
 *
 * `index` 是**必需**的：一轮里可能并行发起多个工具调用，而 `id` 与 `name` 往往只在
 * 第一个片段里出现，后续片段仅带 `arguments` 的一小段。没有 `index` 就无法把碎片
 * 归位到正确的调用上。
 */
export interface ChatToolCallDelta {
  index: number
  id?: string
  type?: 'function'
  function?: {
    name?: string
    arguments?: string
  }
}

export interface ChatChoiceDelta {
  role?: 'assistant'
  content?: string | null
  tool_calls?: ChatToolCallDelta[]
}

export interface ChatChoice {
  index?: number
  delta: ChatChoiceDelta
  /** `stop` / `tool_calls` / `length` 等；到达即本条消息结束。 */
  finish_reason?: string | null
}

/** 一个 `chat.completion.chunk`。 */
export interface ChatCompletionChunk {
  id?: string
  object?: 'chat.completion.chunk'
  created?: number
  model?: string
  choices: ChatChoice[]
}

// ── UI 侧的展示模型 ──────────────────────────────────────────────────

/**
 * 会话里的一条可渲染条目。
 *
 * 它是 {@link ChatMessage} 的**投影**而非替代：协议关心「传什么」，这里关心
 * 「怎么显示」。两者分开，是为了让渲染层的需要（流式中、待确认、失败）不必污染
 * 线协议——那会让本包吐出的消息不再是标准 OpenAI 形状。
 */
export interface ChatEntry {
  /** 稳定标识，供渲染层做列表 diff。 */
  id: string
  role: ChatMessage['role']
  /** 展示文本。工具调用轮次为空串。 */
  content: string
  /** 本条正在流式接收中。渲染层据此显示光标或加载态。 */
  streaming?: boolean
  /** assistant 发起的工具调用，已按 `index` 归位。 */
  toolCalls?: ChatToolCall[]
  /** tool 消息对应的调用 ID。 */
  toolCallId?: string
  /** 工具是否执行成功。仅 tool 角色有值。 */
  ok?: boolean
  /** 该条目产生的时间，由会话注入的时钟给出。 */
  at: number
}

/**
 * 待人工确认的写操作，投影给渲染层。
 *
 * 字段与 `toolairlock` 的 `ConfirmationRequest` 结构兼容，因此接上核心时可直接透传；
 * 单独使用时由驱动方自行构造。
 */
export interface ChatConfirmation {
  confirmationId: string
  toolCallId: string
  functionName: string
  title: string
  rows: Array<{ label: string, value: string }>
  impact?: string
  risk: 'write' | 'destructive'
  rawRequest?: {
    method: string
    url: string
    body?: unknown
  }
}

/** 会话所处的阶段。刻意比 `RunStatus` 粗——界面只需要知道能不能输入。 */
export type ChatStatus = 'idle' | 'busy' | 'awaiting_confirmation'

/** 渲染层需要的全部状态。 */
export interface ChatState {
  entries: ChatEntry[]
  status: ChatStatus
  confirmation?: ChatConfirmation
  /** 最近一次错误的展示文案。 */
  error?: string
}
