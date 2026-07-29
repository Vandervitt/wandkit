/**
 * `@toolairlock/chat/ui` —— 开箱即用的聊天面板。
 *
 * 单独成一个入口，因为它**有副作用**（注册自定义元素）且依赖 DOM。只用无头核心的
 * 接入方不该被迫把它打进包里。
 */
export {
  ToolairlockChatPanel,
  CHAT_PANEL_TAG
} from './panel'
export type { ChatPanelSendDetail } from './panel'
