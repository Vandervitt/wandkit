/**
 * 对齐 OpenAI chat-completions 工具调用形态的传输层类型。
 *
 * 选这套方言是因为主流厂商和网关都认它，宿主可以把自己的后端摆在任意模型前面，
 * 而不需要在浏览器里做协议转换。这里只是数据契约，不意味着一定调用 OpenAI。
 */

/** 模型请求的一次工具调用。 */
export interface LlmToolCall {
  /** 关联 ID。每次调用必须由且仅由一条 tool 消息作答。 */
  id: string
  type: 'function'
  function: {
    /** 来自 {@link buildToolFunctionName} 的稳定名。 */
    name: string
    /** JSON 编码的参数。不可信：使用前必须先解析并做 Schema 校验。 */
    arguments: string
  }
}

export interface LlmSystemMessage {
  role: 'system'
  content: string
}

export interface LlmUserMessage {
  role: 'user'
  content: string
}

export interface LlmAssistantMessage {
  role: 'assistant'
  /**
   * 模型只发出工具调用时，这里为 null 或空串。
   *
   * 带工具调用的轮次里，这个字段常常装的是中间推理，Runtime 不会展示给用户。
   */
  content: string | null
  tool_calls?: LlmToolCall[]
}

/** 单次工具调用的结果，回喂给模型让它继续。 */
export interface LlmToolMessage {
  role: 'tool'
  content: string
  /** 必须与发起的 {@link LlmToolCall.id} 匹配。 */
  tool_call_id: string
}

export type LlmMessage =
  | LlmSystemMessage
  | LlmUserMessage
  | LlmAssistantMessage
  | LlmToolMessage

/**
 * 宿主必须提供的唯一依赖。
 *
 * 实现应当调用宿主**自己的后端**，由后端持有厂商凭据。API Key 绝不能进入浏览器包。
 *
 * @param tools OpenAI 形态的工具定义，已由 Runtime 完成权限过滤与预算裁剪。
 * @param signal 停止或超时时被 abort，请透传给传输层。
 */
export interface LlmClient {
  chat(messages: LlmMessage[], tools: unknown[], signal?: AbortSignal): Promise<LlmAssistantMessage>
}
