import type { LlmAssistantMessage } from '../contracts/llm'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 从发出去的 tools 里取出本轮真实暴露过的函数名集合。 */
function authorizedToolNames(tools: unknown[]): Set<string> {
  const names = new Set<string>()
  tools.forEach(tool => {
    if (!isRecord(tool) || tool.type !== 'function' || !isRecord(tool.function)) return
    if (typeof tool.function.name === 'string') names.add(tool.function.name)
  })
  return names
}

/**
 * 由内容派生一个确定性的 call id（FNV-1a）。
 *
 * 必须确定性：同一条消息被重放时要得到同一个 id，否则历史里会出现两条 id 不同、
 * 内容相同的调用记录。用不着加密强度——它只是个本地关联键，不承担安全职责。
 */
function compatibilityCallId(content: string): string {
  let hash = 2166136261
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `compat_${(hash >>> 0).toString(36)}`
}

/**
 * 严格判定一段文本是否就是一次工具调用。
 *
 * 三道闸，缺一不可，宁可漏判也不能误判：
 * 1. 顶层**恰好**只有 `name` 和 `arguments` 两个键——多一个键就说明它是别的东西；
 * 2. `name` 必须在本轮真实暴露过的工具里——否则就成了绕过权限过滤的旁路；
 * 3. `arguments` 必须是对象。
 *
 * 误判的代价是把用户的一段普通回复当成工具调用执行掉，所以这里刻意做得保守。
 */
function isStrictTextToolCall(
  value: unknown,
  allowedNames: Set<string>
): value is { name: string, arguments: Record<string, unknown> } {
  if (!isRecord(value)) return false
  const keys = Object.keys(value).sort()
  return keys.length === 2 &&
    keys[0] === 'arguments' &&
    keys[1] === 'name' &&
    typeof value.name === 'string' &&
    allowedNames.has(value.name) &&
    isRecord(value.arguments)
}

/**
 * 兼容那些「把工具调用写进 content 里」的模型。
 *
 * 不少国产模型和小参数量模型并不稳定地填 `tool_calls`，而是把
 * `{"name": "...", "arguments": {...}}` 直接吐在文本里。本包不能要求接入方换模型，
 * 因此在这里做一次窄口径的救援。
 *
 * 只在**没有** `tool_calls` 时才尝试，且必须整段内容就是那个 JSON 对象（首尾是花括号）。
 * 任何不满足严格判定的情况都原样返回——把普通回复误解析成工具调用，比漏掉一次兼容
 * 严重得多。
 */
export function normalizeLlmAssistantMessage(
  message: LlmAssistantMessage,
  tools: unknown[]
): LlmAssistantMessage {
  if (message.tool_calls?.length || typeof message.content !== 'string') return message
  const content = message.content.trim()
  if (!content.startsWith('{') || !content.endsWith('}')) return message

  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (_error) {
    return message
  }
  if (!isStrictTextToolCall(parsed, authorizedToolNames(tools))) return message

  return {
    role: 'assistant',
    content: null,
    tool_calls: [{
      id: compatibilityCallId(content),
      type: 'function',
      function: {
        name: parsed.name,
        arguments: JSON.stringify(parsed.arguments)
      }
    }]
  }
}
