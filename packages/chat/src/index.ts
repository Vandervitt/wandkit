/**
 * `@toolairlock/chat` —— 无头会话核心 + 可选聊天面板。
 *
 * 三个入口，按需取用：
 *
 * | 入口 | 内容 | 依赖 |
 * |---|---|---|
 * | `@toolairlock/chat` | {@link ChatSession} 与协议类型 | 无，纯逻辑零 DOM |
 * | `@toolairlock/chat/ui` | `<toolairlock-chat>` 面板 | DOM |
 * | `@toolairlock/chat/bridge` | 接 `AgentRuntime` | 无（鸭子类型，不 import 核心） |
 *
 * **可以单独使用。** 会话只认 OpenAI chat-completions 形态的消息与流式增量，因此
 * 接入方拿自己的后端直接驱动它即可，完全不需要 toolairlock 运行时。接了核心时，
 * 因为核心的 `LlmMessage` 就是同一套形状，两边不需要任何格式转换。
 *
 * **也可以只要核心不要界面。** `ChatSession` 不碰 DOM，把它接到自己的 React / Vue
 * 组件上是一等用法，而不是变通。
 */

export { ChatSession } from './session'
export type { ChatSessionOptions } from './session'

export type {
  ChatMessage,
  ChatSystemMessage,
  ChatUserMessage,
  ChatAssistantMessage,
  ChatToolMessage,
  ChatToolCall,
  ChatCompletionChunk,
  ChatChoice,
  ChatChoiceDelta,
  ChatToolCallDelta,
  ChatEntry,
  ChatConfirmation,
  ChatState,
  ChatStatus
} from './protocol'
