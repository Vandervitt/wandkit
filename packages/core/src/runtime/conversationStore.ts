import type { LlmMessage } from '../contracts/llm'
import type { ToolResult } from '../contracts/result'
import { deepClone } from './deepClone'

/**
 * 会话历史，附带一个可回滚的安全点。
 *
 * 全部进出都做深拷贝：历史会被发给模型，也会被宿主界面读取，任何一处不小心改动都会
 * 污染后续所有轮次，而这种污染极难从现象反推。
 */
export class ConversationStore {
  private history: LlmMessage[] = []
  private safePoint: number | null = null

  /** 历史的只读拷贝。改它不会影响存储本身。 */
  get messages(): readonly LlmMessage[] {
    return deepClone(this.history)
  }

  push(message: LlmMessage): void {
    this.history.push(deepClone(message))
  }

  /**
   * 追加一条工具结果消息。
   *
   * 落库前会剥掉 `uiEffect`：它是给页面的指令，可能夹带整页表格数据。留在历史里会
   * 在后续每一轮重复消耗 token，而模型完全用不上它——模型要的是结论，不是渲染负载。
   */
  appendToolResult(toolCallId: string, result: ToolResult): void {
    const historyResult = deepClone(result)
    delete historyResult.uiEffect
    this.history.push({
      role: 'tool',
      tool_call_id: toolCallId,
      content: JSON.stringify(historyResult)
    })
  }

  /** 在当前长度打一个安全点。Run 启动时调用。 */
  markSafePoint(): void {
    this.safePoint = this.history.length
  }

  /**
   * 回滚到安全点，丢弃本次 Run 写入的全部内容。
   *
   * 用户中途停止时必须这么做：此时历史里很可能留着一条带 `tool_calls` 却没有对应
   * tool 消息的 assistant 消息。这在工具调用协议里是非法的，下一个 Run 带上它会被
   * 厂商直接拒绝——不是质量下降，是整条会话就此不可用。
   */
  rollbackToSafePoint(): void {
    if (this.safePoint === null) return
    this.history.splice(this.safePoint)
  }

  clear(): void {
    this.history = []
    this.safePoint = null
  }
}
