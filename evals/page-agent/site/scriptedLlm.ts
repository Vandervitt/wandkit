import type {
  LlmAssistantMessage,
  LlmClient,
  LlmMessage
} from '../../../packages/core/src/index'

export interface ScriptedLlmRequest {
  readonly messages: readonly LlmMessage[]
  readonly tools: readonly unknown[]
}

let nextToolCallId = 0

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** 构造 OpenAI-compatible 的单次工具调用响应。 */
export function toolCall(
  name: string,
  args: unknown,
  id = `scripted-call-${++nextToolCallId}`
): LlmAssistantMessage {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [{
      id,
      type: 'function',
      function: {
        name,
        arguments: JSON.stringify(args) ?? 'null'
      }
    }]
  }
}

/** 构造不再调用工具的最终回答。 */
export function finalAnswer(content: string): LlmAssistantMessage {
  return { role: 'assistant', content }
}

/**
 * 浏览器可用的确定性 LLM：逐项回放预设响应，并保存每轮请求快照。
 */
export class ScriptedLlm implements LlmClient {
  private readonly replies: LlmAssistantMessage[]
  private readonly requestLog: ScriptedLlmRequest[] = []

  constructor(replies: readonly LlmAssistantMessage[]) {
    this.replies = cloneJson([...replies])
  }

  get requests(): readonly ScriptedLlmRequest[] {
    return this.requestLog
  }

  async chat(
    messages: LlmMessage[],
    tools: unknown[],
    signal?: AbortSignal
  ): Promise<LlmAssistantMessage> {
    if (signal?.aborted) {
      const error = new Error('The operation was aborted')
      error.name = 'AbortError'
      throw error
    }

    this.requestLog.push({
      messages: cloneJson(messages),
      tools: cloneJson(tools)
    })

    const reply = this.replies.shift()
    if (!reply) throw new Error('Scripted LLM replies exhausted')
    return cloneJson(reply)
  }
}
