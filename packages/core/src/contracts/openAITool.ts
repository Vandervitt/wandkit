import {
  buildToolFunctionName,
  type ToolDefinition
} from './tool'

/** OpenAI chat-completions `tools[]` 形态的工具。 */
export interface OpenAIToolDefinition {
  type: 'function'
  function: {
    /** 来自 {@link buildToolFunctionName} 的稳定名，如 `user_query_v1`。 */
    name: string
    /** 模型挑选该工具时真正推理的内容。 */
    description: string
    /** 工具的 TypeBox Schema，其本身就是合法 JSON Schema。 */
    parameters: ToolDefinition['schema']
  }
}

/**
 * 追加到每个写工具描述末尾的说明。
 *
 * 模型默认会认为「调用工具 = 已提交」，于是自作主张用自然语言索要批准（"要删除吗？
 * 是/否"）。这在本包里是有害的：它训练用户在聊天里点头，而不是在真正的确认卡片上
 * 点头——只有那张卡片才展示了经过核验的目标与影响。把机制直说，能从源头掐掉这个行为。
 */
const WRITE_TOOL_CONFIRMATION_NOTICE =
  'Calling this only prepares confirmation content; it never performs the write. '
  + 'The runtime renders a structured confirmation card and handles the user response. '
  + 'Do not request or simulate confirmation in plain text.'

/** 写 / 破坏性工具带上确认说明；读工具按作者原文发送。 */
function descriptionForOpenAI(tool: ToolDefinition): string {
  return tool.risk === 'write' || tool.risk === 'destructive'
    ? `${tool.description}\n${WRITE_TOOL_CONFIRMATION_NOTICE}`
    : tool.description
}

/**
 * 把内部工具定义投影成发给模型的传输格式。
 *
 * 刻意有损：`risk`、`permissions`、`executionMode`、`owner` 和生命周期都留在服务侧。
 * 模型需要知道一个工具**做什么**，而不需要知道 Runtime 如何治理它——泄漏权限词表
 * 反而会诱导它去推理自己根本无权干预的访问控制。
 */
export function toOpenAIToolDefinition(
  tool: ToolDefinition
): OpenAIToolDefinition {
  return {
    type: 'function',
    function: {
      name: buildToolFunctionName(tool.moduleId, tool.name, tool.version),
      description: descriptionForOpenAI(tool),
      parameters: tool.schema
    }
  }
}
