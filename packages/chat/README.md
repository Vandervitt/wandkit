# @toolairlock/chat

无头会话核心 + 可选聊天面板。**通信基于 OpenAI chat-completions 协议**，因此既能接
`toolairlock` 核心运行时，也能完全脱离它单独使用。

## 三个入口

| 入口 | 内容 | 依赖 |
|---|---|---|
| `@toolairlock/chat` | `ChatSession` 与协议类型 | 无，纯逻辑零 DOM |
| `@toolairlock/chat/ui` | `<toolairlock-chat>` 面板 | DOM |
| `@toolairlock/chat/bridge` | 接 `AgentRuntime` | 无（鸭子类型，不 import 核心） |

按需取用——只要无头核心时，面板与桥接不会被打进包里。

## 单独使用

只要驱动方吐的是 OpenAI 形状，会话就能跑，不需要 toolairlock 运行时。

```ts
import { ChatSession } from '@toolairlock/chat'

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
import { ChatSession } from '@toolairlock/chat'
import { connectRuntime } from '@toolairlock/chat/bridge'

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
import '@toolairlock/chat/ui'

const panel = document.createElement('toolairlock-chat')
panel.addEventListener('send', event => controls.send(event.detail.text))
session.subscribe(state => { panel.state = state })
container.appendChild(panel)
```

面板自己不持有状态：`state` 进、事件出。因此把同一个会话接到自己的 React / Vue
组件上是一等用法，而不是变通。

样式通过 `::part()` 与 CSS 变量定制：

- part：`log` `entry` `bubble` `tools` `tool-chip` `cursor` `error` `confirmation`
  `composer` `input` `send`
- 变量：`--tal-fg` `--tal-bg` `--tal-border` `--tal-danger` `--tal-radius` `--tal-font`
  `--tal-user-bg` `--tal-bubble-bg`

### 确认卡片不由本面板渲染

面板只留一个挂载点（`panel.confirmationHost`），宿主把 `@toolairlock/ui` 的
`<toolairlock-confirm>` 放进去。

这是刻意的分工：确认卡片是**治理层唯一面向人的界面**，它的结构没有关闭开关；而聊天
面板是产品组件，完全可以被替换。两者混在一起，替换面板就会顺手把卡片一起换掉。

```ts
import { CONFIRM_CARD_TAG } from '@toolairlock/ui'

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

## 两份数据

会话内部同时维护线协议原文与展示投影：

- `toMessages()` —— **标准 OpenAI 消息**，导出给下一轮请求
- `state.entries` —— 展示投影，带 `streaming` / `ok` 这类渲染才需要的标记

不合并成一份，是因为渲染需要的东西一旦塞进消息，吐出去的就不再是标准形状了。

## 状态

`idle` / `busy` / `awaiting_confirmation`。比核心的 `RunStatus` 粗——界面只需要知道
能不能接受输入。`busy` 与 `awaiting_confirmation` 都会锁住输入框：后者意味着屏幕上有
一张待处理的确认卡片，允许继续发话会让人绕过它。

## 可运行样例

```bash
npm run example:chat
```

同一个 `ChatSession`，先独立跑一遍流式响应，再接上运行时跑一遍带闸门的删除。
