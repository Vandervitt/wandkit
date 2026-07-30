/**
 * 接真实厂商接口的 `LlmClient`，供集成测试使用。
 *
 * **不导出到 `toolairlock/testing` 入口**：它读 `.env`、依赖 `node:fs`、会真的发网络
 * 请求，这三件事都不该出现在发布产物里。需要确定性回放的单测继续用 `FakeLlm`。
 *
 * 之所以要有它：本包最贵的几个缺陷都不是逻辑写错，而是**跨层契约的缺口**——事件里
 * 少一个字段、空回答被静默丢弃。这类缺口在回放式单测里天然不可见，因为回放的响应
 * 正是写测试的人想象中的响应。只有真实模型（会返回空 content、会多绕几轮、会在
 * 鉴权失败时抛真实 HTTP 错误）才踩得出来。
 */
import { readFileSync } from 'node:fs'
import type { LlmAssistantMessage, LlmClient, LlmMessage } from '../contracts/llm'

/** 极简 .env 解析：测试夹具不值得为此引一个依赖。与 examples 里的同款。 */
function loadEnv(): Record<string, string> {
  const env: Record<string, string> = { ...process.env as Record<string, string> }
  try {
    readFileSync(new URL('../../../../.env', import.meta.url), 'utf8')
      .split('\n')
      .forEach(line => {
        const matched = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/)
        if (matched && !env[matched[1]]) env[matched[1]] = matched[2].trim()
      })
  } catch (_error) {
    // 没有 .env 就只用真实环境变量
  }
  return env
}

const env = loadEnv()

export const REAL_LLM_BASE_URL = env.LLM_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4'
export const REAL_LLM_MODEL = env.LLM_MODEL || 'glm-4-flash'
export const REAL_LLM_API_KEY = env.LLM_API_KEY

/** 没有 Key 时集成测试必须显式跳过，而不是静静地变成空跑。 */
export const hasRealLlm = Boolean(REAL_LLM_API_KEY)

export interface RealLlmOptions {
  /** 覆盖 Key。传一个无效值即可制造**真实的**鉴权失败。 */
  apiKey?: string
  model?: string
  baseUrl?: string
  /** 每次请求的入参与出参都记下来，便于失败时看清模型到底决定了什么。 */
  onExchange?(messages: LlmMessage[], reply: LlmAssistantMessage): void
}

/**
 * 造一个真调厂商接口的 `LlmClient`。
 *
 * `temperature: 0` 是为了把模型的随机性压到最低——集成测试断言的是「链路把原因带
 * 出来了」这类不变量，不该因为模型换了个说法就红。
 */
export function createRealLlm(options: RealLlmOptions = {}): LlmClient {
  const baseUrl = options.baseUrl ?? REAL_LLM_BASE_URL
  const model = options.model ?? REAL_LLM_MODEL
  const apiKey = options.apiKey ?? REAL_LLM_API_KEY

  return {
    async chat(
      messages: LlmMessage[],
      tools: unknown[],
      signal?: AbortSignal
    ): Promise<LlmAssistantMessage> {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({ model, messages, tools, temperature: 0 }),
        signal
      })

      if (!response.ok) {
        throw new Error(`LLM ${response.status}: ${(await response.text()).slice(0, 300)}`)
      }
      const payload = await response.json() as {
        choices?: Array<{ message?: LlmAssistantMessage }>
      }
      const message = payload.choices?.[0]?.message
      if (!message) throw new Error('LLM 返回结构异常')
      const reply: LlmAssistantMessage = {
        role: 'assistant',
        content: message.content ?? null,
        tool_calls: message.tool_calls
      }
      options.onExchange?.(messages, reply)
      return reply
    }
  }
}
