import type {
  LlmAssistantMessage,
  LlmClient,
  LlmMessage
} from '../../../packages/core/src/index'

export interface OpenAICompatibleExchange {
  readonly request: {
    readonly model: string
    readonly messages: readonly LlmMessage[]
    readonly tools: readonly unknown[]
    readonly temperature: 0
  }
  readonly response: {
    readonly status: number
    readonly body: unknown
  }
}

export interface OpenAICompatibleLlmOptions {
  readonly endpoint: string
  readonly model: string
  readonly maxRounds?: number
  readonly fetchImpl?: typeof fetch
  readonly onExchange?: (exchange: OpenAICompatibleExchange) => void
}

export const OPENAI_COMPATIBLE_MAX_ROUNDS_ERROR_CODE =
  'PAGE_AGENT_EVAL_REAL_MAX_ROUNDS_EXCEEDED'
export const PAGE_AGENT_EVAL_REAL_INFRASTRUCTURE_ERROR =
  'PAGE_AGENT_EVAL_REAL_INFRASTRUCTURE_ERROR'

function cloneJson<Value>(value: Value): Value {
  return JSON.parse(JSON.stringify(value)) as Value
}

function parseResponseBody(text: string): unknown {
  if (text === '') return ''
  try {
    return JSON.parse(text) as unknown
  } catch (_error) {
    return text
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isToolCall(value: unknown): boolean {
  if (!isRecord(value) || value.type !== 'function' || !isRecord(value.function)) {
    return false
  }
  return typeof value.id === 'string' &&
    typeof value.function.name === 'string' &&
    typeof value.function.arguments === 'string'
}

function assistantMessageFrom(body: unknown): LlmAssistantMessage | undefined {
  if (!isRecord(body) || !isRecord(body.message)) return undefined
  const message = body.message
  if (
    message.role !== 'assistant' ||
    (message.content !== null && typeof message.content !== 'string') ||
    (
      message.tool_calls !== undefined &&
      (!Array.isArray(message.tool_calls) || !message.tool_calls.every(isToolCall))
    )
  ) {
    return undefined
  }
  return {
    role: 'assistant',
    content: message.content,
    ...(message.tool_calls === undefined
      ? {}
      : {
        tool_calls: cloneJson(message.tool_calls) as NonNullable<
          LlmAssistantMessage['tool_calls']
        >
      })
  }
}

function responseErrorDetail(body: unknown): string {
  if (isRecord(body) && typeof body.error === 'string') return body.error
  if (typeof body === 'string') return body.slice(0, 300)
  return JSON.stringify(body).slice(0, 300)
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    'name' in error && error.name === 'AbortError'
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function infrastructureError(message: string): Error {
  return new Error(`${PAGE_AGENT_EVAL_REAL_INFRASTRUCTURE_ERROR}: ${message}`)
}

export function createOpenAICompatibleLlm(
  options: OpenAICompatibleLlmOptions
): LlmClient {
  const fetchImpl = options.fetchImpl ?? fetch
  if (
    options.maxRounds !== undefined &&
    (!Number.isSafeInteger(options.maxRounds) || options.maxRounds <= 0)
  ) {
    throw new Error('maxRounds 必须是正整数')
  }
  const maxRounds = options.maxRounds ?? Infinity
  let rounds = 0

  return {
    async chat(
      messages: LlmMessage[],
      tools: unknown[],
      signal?: AbortSignal
    ): Promise<LlmAssistantMessage> {
      if (rounds >= maxRounds) {
        throw new Error(
          `${OPENAI_COMPATIBLE_MAX_ROUNDS_ERROR_CODE}: ` +
          `单次尝试超过 ${maxRounds} 个模型轮次`
        )
      }
      rounds += 1
      const request = {
        model: options.model,
        messages: cloneJson(messages),
        tools: cloneJson(tools),
        temperature: 0 as const
      }
      let response: Response

      try {
        response = await fetchImpl(options.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
          signal
        })
      } catch (error) {
        if (isAbortError(error)) throw error
        throw infrastructureError(
          `OpenAI-compatible 代理请求失败: ${errorDetail(error)}`
        )
      }

      let responseText: string
      try {
        responseText = await response.text()
      } catch (error) {
        if (isAbortError(error)) throw error
        throw infrastructureError(
          `OpenAI-compatible 代理响应读取失败: ${errorDetail(error)}`
        )
      }
      const responseBody = parseResponseBody(responseText)
      options.onExchange?.({
        request,
        response: { status: response.status, body: responseBody }
      })

      if (!response.ok) {
        throw infrastructureError(
          `OpenAI-compatible 代理 HTTP ${response.status}: ${
            responseErrorDetail(responseBody)
          }`
        )
      }

      if (
        !isRecord(responseBody) ||
        typeof responseBody.model !== 'string' ||
        responseBody.model.trim() === ''
      ) {
        throw infrastructureError(
          'OpenAI-compatible 代理返回结构异常: 缺少实际 model'
        )
      }
      if (responseBody.model !== options.model) {
        throw infrastructureError(
          `OpenAI-compatible 代理模型不一致: 请求 ${options.model}，` +
          `响应 ${responseBody.model}`
        )
      }

      const message = assistantMessageFrom(responseBody)
      if (!message) {
        throw infrastructureError(
          'OpenAI-compatible 代理返回结构异常: 缺少 assistant message'
        )
      }
      return message
    }
  }
}
