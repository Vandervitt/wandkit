/**
 * `@wandkit/chat/ui` —— 开箱即用的聊天面板与悬浮壳。
 *
 * 单独成一个入口，因为它**有副作用**（注册自定义元素）且依赖 DOM。只用无头核心的
 * 接入方不该被迫把它打进包里。
 *
 * 两个元素分工清楚，可以只用其中一个：
 *
 * | 元素 | 管什么 |
 * |---|---|
 * | `<wandkit-chat>` | 会话内容——消息、状态、输入框 |
 * | `<wandkit-dock>` | 在不在、多大、在哪儿——收起成图标，展开成浮层 |
 *
 * 已有自己的抽屉或侧栏的接入方只取面板即可；壳是为了让「嵌进别人的应用」这件事不必
 * 每次都手写一遍定位样板。
 */
export {
  WandkitChatPanel,
  CHAT_PANEL_TAG
} from './panel'
export type { ChatPanelSendDetail } from './panel'

export {
  WandkitChatDock,
  CHAT_DOCK_TAG,
  DOCK_LAYER
} from './dock'
export type { ChatDockToggleDetail } from './dock'
