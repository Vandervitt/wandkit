/**
 * `@wandkit/ui` —— 治理层面向人的那两个界面。
 *
 * 只包含**安全承重**的组件，不提供聊天面板：
 *
 * - {@link WandkitConfirmCard} 是「披露真相」的唯一界面。少展示一部分（比如藏起
 *   原始请求、弱化拒绝按钮），治理就静默失效了，所以它的结构没有关闭开关。
 * - {@link InteractionMask} 是归属判定的前提。没有它，用户手动点的请求会被误判成
 *   Agent 的，API 层拦截的地基就塌了。
 *
 * 消息气泡、markdown 渲染、历史记录这些属于产品，由接入方自己实现。
 *
 * 两者都是原生自定义元素 + Shadow DOM，零框架依赖，样式与宿主完全隔离——要能塞进
 * Vue 2 + Element UI 的老后台，也要能塞进 React 项目。
 */
export {
  WandkitConfirmCard,
  CONFIRM_CARD_TAG
} from './confirmCard'
export type {
  ConfirmCardData,
  ConfirmCardRow,
  ConfirmCardRawRequest
} from './confirmCard'

export {
  InteractionMask,
  WandkitMaskElement,
  MASK_TAG,
  MASK_LAYER
} from './mask'
export type { InteractionMaskOptions } from './mask'

export { withMaskReleased, createMaskReleaser } from './maskRelease'
export type { ReleasableMask } from './maskRelease'
