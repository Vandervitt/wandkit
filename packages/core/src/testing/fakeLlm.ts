import type {
  LlmAssistantMessage,
  LlmClient,
  LlmMessage
} from '../contracts/llm'
import { deepClone } from '../runtime/deepClone'

/**
 * 按脚本回放预设响应的假 LLM。
 *
 * 让 Runtime 的行为可以被确定性地测试：真实模型每次返回都不同，而这里要验证的是调度、
 * 确认和错误处理——它们必须对固定输入给出固定结果。
 */
export class FakeLlm implements LlmClient {
  public readonly requests: Array<{
    messages: LlmMessage[]
    tools: unknown[]
  }> = []

  private readonly replies: LlmAssistantMessage[]

  constructor(replies: LlmAssistantMessage[]) {
    this.replies = [...replies]
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
    this.requests.push({
      messages: deepClone(messages),
      tools: deepClone(tools)
    })
    const next = this.replies.shift()
    if (!next) throw new Error('Fake LLM reply exhausted')
    return next
  }
}
