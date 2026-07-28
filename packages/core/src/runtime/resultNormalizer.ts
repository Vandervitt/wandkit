import { cancelledResult, type ToolResult } from '../contracts/result'
import { defaultMessages, type AirlockMessages } from '../config/messages'

export { cancelledResult }

/*
 * 把「异常」归一成「给用户看的 ToolResult」。
 *
 * 统一收在这里而不是散在各调用点，是为了保证一件事：原始错误对象永远不会漏到界面上。
 * Ajv 的字段路径、fetch 的堆栈、后端的内部错误码，对用户既无意义，又是轻微的信息泄漏。
 * 原始 error 交给 trace 和控制台，用户只拿到可执行的一句话。
 */

export function invalidJsonResult(messages: AirlockMessages = defaultMessages): ToolResult {
  return { ok: false, message: messages.invalidJson }
}

export function invalidInputResult(
  _error: unknown,
  messages: AirlockMessages = defaultMessages
): ToolResult {
  // 参数校验失败的原始 message 由 Ajv errorsText 生成，含 data.xxx 这类内部字段路径，
  // 直接展示既不可读又有轻微泄漏，因此统一归一为业务话术。
  return { ok: false, message: messages.invalidInput }
}

export function executionFailureResult(
  _error: unknown,
  messages: AirlockMessages = defaultMessages
): ToolResult {
  return { ok: false, message: messages.executionFailure }
}

/**
 * 解析模型给出的 arguments 字符串。
 *
 * 返回判别联合而不是抛异常：参数非法是**预期内**的模型行为，不是程序错误。调用方需要
 * 拿着这个失败结果回喂给模型让它自我纠正，而 try/catch 会诱导人把它当成异常路径处理。
 */
export function parseToolArguments(
  serialized: string,
  messages: AirlockMessages = defaultMessages
):
  | { ok: true, value: unknown }
  | { ok: false, result: ToolResult } {
  try {
    return { ok: true, value: JSON.parse(serialized) }
  } catch (_error) {
    return { ok: false, result: invalidJsonResult(messages) }
  }
}
