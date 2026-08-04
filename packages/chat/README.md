# @wandkit/chat

无头会话核心 + 可选聊天面板。**通信基于 OpenAI chat-completions 协议**，因此既能接
`wandkit` 核心运行时，也能完全脱离它单独使用。

## 三个入口

| 入口 | 内容 | 依赖 |
|---|---|---|
| `@wandkit/chat` | `ChatSession` 与协议类型 | 无，纯逻辑零 DOM |
| `@wandkit/chat/ui` | `<wandkit-chat>` 面板 + `<wandkit-dock>` 悬浮壳 | DOM |
| `@wandkit/chat/bridge` | 接 `AgentRuntime` | 无（鸭子类型，不 import 核心） |

按需取用——只要无头核心时，面板与桥接不会被打进包里。

## 单独使用

只要驱动方吐的是 OpenAI 形状，会话就能跑，不需要 wandkit 运行时。

```ts
import { ChatSession } from '@wandkit/chat'

const session = new ChatSession()
session.subscribe(state => render(state))

session.appendUser('查一下待审核用户')

// 完整消息
session.append({ role: 'assistant', content: '共 2 位。' })

// 或流式增量（chat.completion.chunk）
session.applyChunk({ choices: [{ delta: { role: 'assistant', content: '共 ' } }] })
session.applyChunk({ choices: [{ delta: { content: '2 位。' } }] })
session.applyChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] })

// 导出为下一轮请求的 messages —— 标准 OpenAI 形状，可直接发出去
await fetch('/api/chat', {
  method: 'POST',
  body: JSON.stringify({ messages: session.toMessages() })
})
```

流式的工具调用碎片按 `index` 归位——`id` 与 `name` 通常只在首个片段出现，后续片段仅带
`arguments` 的一小段，而一轮里可能并行发起多个调用。

## 接上核心运行时

核心的 `LlmMessage` 就是同一套形状，因此两边**不需要任何格式转换**。

```ts
import { ChatSession } from '@wandkit/chat'
import { connectRuntime } from '@wandkit/chat/bridge'

const session = new ChatSession()
const handlers = []

const runtime = new AgentRuntime({
  // …其余依赖
  emit: event => handlers.forEach(handler => handler(event))
})

const controls = connectRuntime(session, runtime, {
  onEvent: handler => handlers.push(handler)
})

await controls.send('把张三删掉')
// → 写操作挂起，session.state.confirmation 出现待确认项
await controls.approve(session.state.confirmation.confirmationId)
```

`onEvent` 要由宿主传进来，是因为 `AgentRuntime` 的事件出口是构造时注入的 `emit`
回调，运行时本身没有订阅接口。

### 失败终态如何展示

桥接层按以下顺序选择用户可见的错误：

```text
snapshot.outcome.error.message
  → stopReason
  → Chat bridge 本地兜底文案
```

新 Runtime 的结构化 `outcome.kind` / `outcome.error.code` 用于程序判断，`message` 只用于
展示。旧 Runtime 若还没有 `outcome`，继续只传 `stopReason` 即可；两者都缺失时桥接层仍会
留下可见错误，不会静默切回 `idle`。这一兼容通过最小鸭子类型完成，chat 包仍不 import
或硬依赖 Core。

### assistant 事件要补上 tool_calls

核心的 `RuntimeUiEvent` **不带** `tool_calls`。缺了它，随后的 tool 结果在导出历史里
会成为没有发起者的孤儿——OpenAI 协议要求每条 `tool` 消息都由某个 `tool_calls` 发起，
厂商会拒绝整条会话。

宿主从模型响应里捕获后补给桥接层：

```ts
let lastToolCalls
const llm = {
  async chat(...args) {
    const reply = await backend.chat(...args)
    lastToolCalls = reply.tool_calls
    return reply
  }
}

const runtime = new AgentRuntime({
  llm,
  // …
  emit: event => {
    const enriched = event.type === 'assistant'
      ? { ...event, toolCalls: lastToolCalls }
      : event
    handlers.forEach(handler => handler(enriched))
  }
})
```

顺带的好处是界面能显示「Agent 正在调用哪个工具」。

**过期确认 ID 不会打到运行时上**：上一个 Run 遗留在屏幕上的卡片回传的是已不当前的
ID，放行它等于用旧的同意批准当前这次写入。

## 用自带面板

```ts
import '@wandkit/chat/ui'

const panel = document.createElement('wandkit-chat')
panel.addEventListener('send', event => controls.send(event.detail.text))
session.subscribe(state => { panel.state = state })
container.appendChild(panel)
```

面板自己不持有状态：`state` 进、事件出。因此把同一个会话接到自己的 React / Vue
组件上是一等用法，而不是变通。

### 标题栏上的两个动作

| 事件 | 触发 | 谁来做 |
|---|---|---|
| `new-chat` | 点垃圾桶 | 宿主。通常是 `session.clear()`，外加收拾会话之外的残留（遮罩、挂起的闸门 Promise） |
| `close` | 点关闭 | 悬浮壳自动收起；不用壳的接入方自己监听 |

两个都**只派发事件，不自己动手**：面板不持有状态，清空得由持有它的一方来做；收起与否更是
壳的事，面板不该知道自己被装在什么里面。

执行中与空会话时新建按钮不可点——前者会让运行中的 Run 失去落点，后者是个什么都不做的按钮。
关闭任何时候都能点，收起不影响 Run。

样式通过 `::part()` 与 CSS 变量定制：

- part：`log` `entry` `bubble` `cursor` `step` `step-spinner` `step-label` `error`
  `confirmation` `composer` `input` `send` `action` `new-chat` `close`
- 变量：`--wandkit-fg` `--wandkit-dim` `--wandkit-faint` `--wandkit-border`
  `--wandkit-glass` `--wandkit-accent` `--wandkit-success` `--wandkit-danger`
  `--wandkit-font` `--wandkit-bg` `--wandkit-mono`

### 确认卡片不由本面板渲染

面板只留一个挂载点（`panel.confirmationHost`），宿主把 `@wandkit/ui` 的
`<wandkit-confirm>` 放进去。

这是刻意的分工：确认卡片是**治理层唯一面向人的界面**，它的结构没有关闭开关；而聊天
面板是产品组件，完全可以被替换。两者混在一起，替换面板就会顺手把卡片一起换掉。

```ts
import { CONFIRM_CARD_TAG } from '@wandkit/ui'

session.subscribe(state => {
  panel.state = state
  panel.confirmationHost.replaceChildren()
  if (!state.confirmation) return
  const card = document.createElement(CONFIRM_CARD_TAG)
  card.data = state.confirmation
  card.addEventListener('approve', e => controls.approve(e.detail.confirmationId))
  card.addEventListener('reject', e => controls.reject(e.detail.confirmationId))
  panel.confirmationHost.appendChild(card)
})
```

## 嵌进别人的应用：悬浮壳

面板自己只声明 `height: 100%`，定位交给宿主——于是接入方总要手写一段固定侧栏，助手常驻
压住右侧一整条，还没有收起。那段样板由 `<wandkit-dock>` 接管：**收起时只是右下角一个
图标，展开时是浮在应用之上的一块面板**，不参与宿主布局，不占据任何空间。

```ts
import { CHAT_DOCK_TAG, CHAT_PANEL_TAG } from '@wandkit/chat/ui'

const dock = document.createElement(CHAT_DOCK_TAG)
const panel = document.createElement(CHAT_PANEL_TAG)
dock.appendChild(panel)
document.body.appendChild(dock)

panel.addEventListener('send', event => controls.send(event.detail.text))
panel.addEventListener('new-chat', () => session.clear())
session.subscribe(state => {
  panel.state = state
  dock.state = state   // 壳只取「忙不忙」和「有没有事等人决定」
})
```

壳与面板之间没有耦合：壳把插槽内容撑满，塞自己的 React / Vue 组件同样可用。收起由内容里
冒泡上来的 `close` 事件触发（面板标题栏的关闭按钮就派发它），因此换掉面板只要照样派发一个
`close`。展开后右下角图标会让位——留着只会被面板压住露出一角，看起来像点不了。

- part：`frame` `launcher` `badge` `icon`
- 变量：`--wandkit-dock-inset` `--wandkit-dock-width` `--wandkit-dock-height`
  `--wandkit-dock-size` `--wandkit-accent` `--wandkit-danger` `--wandkit-font`
- 事件：`dock-toggle`（`detail.open`），宿主可据此记住展开偏好
- 属性：`open` 双向可写并反射为 `[open]`；`Esc` 收起

### 待确认会强制展开

收起是用户的意愿，`dock.state` 却会在出现待确认项或错误时违反它。因为待确认意味着某个真实
写请求正挂在半空：用户看不到卡片就不会点，业务侧只表现为按钮一直转圈，**治理就此静默失效**。
同一件事只弹一次——用户手动收起后壳不再跟他抢这个按钮，换了另一个待确认项才重新展开。

### 层级高于遮罩，因此不必再撤罩

壳的 `z-index` 是 `DOCK_LAYER`（2147483647），比 `@wandkit/ui` 的 `MASK_LAYER` 高一级
——遮罩刻意让出的正是这一档。确认卡片挂在面板里，壳在遮罩之上才点得动。

于是接入方**不需要**在确认期间撤掉遮罩（`createMaskReleaser`）：遮罩的职责是挡住用户操作
**宿主页面**，治理界面本就该始终可点。两件事分开比在时序上互相让位可靠。自己放置卡片、
容器层级低于遮罩的接入方仍然需要它。

## 两份数据

会话内部同时维护线协议原文与展示投影：

- `toMessages()` —— **标准 OpenAI 消息**，导出给下一轮请求
- `state.entries` —— 展示投影，只含 user / assistant 的**对话内容**

不合并成一份，是因为渲染需要的东西一旦塞进消息，吐出去的就不再是标准形状了。

**工具调用与工具结果不进 `entries`。** 它们留在 `toMessages()` 里（协议要求每条
tool 消息都有发起者，删掉就非法），但不投影成条目——展示出来就是 `page_click_v1`、
`✓ 已点击 [0]` 这类内部函数名与元素下标，还会把唯一一句真正的回答淹没在十几条噪声里。

执行过程改由 `state.progress` 承载：一句业务语言（「已打开「员工管理」」），取自最近
一次成功的工具结果，仅 `busy` 期间有值，Run 一结束即清空。自带面板把它渲染成末尾一行
`part="step"`，明细去 `runtime.traces` 里查。

## 状态

`idle` / `busy` / `awaiting_confirmation`。比核心的 `RunStatus` 粗——界面只需要知道
能不能接受输入。`busy` 与 `awaiting_confirmation` 都会锁住输入框：后者意味着屏幕上有
一张待处理的确认卡片，允许继续发话会让人绕过它。

## 可运行样例

```bash
npm run example:chat
```

同一个 `ChatSession`，先独立跑一遍流式响应，再接上运行时跑一遍带闸门的删除。
