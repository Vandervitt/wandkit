/**
 * `@toolairlock/chat` 的两种用法。
 *
 * 【一】完全独立：不装 toolairlock，只把 OpenAI 形态的消息喂给会话。
 * 【二】接上核心：`AgentRuntime` 的事件经桥接层变成会话状态，写操作照样过闸门。
 *
 * 运行：npm run example:chat
 */
import { Type } from '@sinclair/typebox'
import {
  AgentRuntime,
  ActionRouter,
  NavigationCoordinator,
  PageAdapterRegistry,
  createToolRegistry,
  resolveCandidates,
  composePromptMessages,
  defineReadTool,
  defineWriteTool,
  type LlmAssistantMessage,
  type ModuleDefinition
} from '../packages/core/src/index'
import { FakeLlm } from '../packages/core/src/testing/fakeLlm'
import { ChatSession } from '../packages/chat/src/index'
import { connectRuntime, type RuntimeUiEventLike } from '../packages/chat/src/bridge'

const line = (title: string): void => console.log(`\n${'─'.repeat(64)}\n${title}\n`)

/** 把会话状态渲染成终端可读的样子——真实项目里这一步交给 UI 组件。 */
function render(session: ChatSession): void {
  session.state.entries.forEach(entry => {
    const prefix = { user: '  用户 ▸', assistant: '  助手 ◂', tool: '       ', system: '' }[entry.role]
    const mark = entry.ok === undefined ? '' : entry.ok ? '✓ ' : '✕ '
    if (entry.content) console.log(`${prefix} ${mark}${entry.content}${entry.streaming ? '▋' : ''}`)
    entry.toolCalls?.forEach(call => console.log(`         ⚙ ${call.function.name}`))
  })
  if (session.state.confirmation) {
    const c = session.state.confirmation
    console.log(`\n  ┌─ ${c.title}（风险=${c.risk}）`)
    c.rows.forEach(row => console.log(`  │  ${row.label}: ${row.value}`))
    if (c.rawRequest) console.log(`  │  ${c.rawRequest.method} ${c.rawRequest.url}`)
    console.log('  └─ 等待人工确认')
  }
  if (session.state.error) console.log(`  ⚠ ${session.state.error}`)
}

// ══ 用法一：完全独立，不需要 toolairlock ════════════════════════════
line('【用法一】独立使用 —— 只喂 OpenAI 形态的数据，零 toolairlock 依赖')

const standalone = new ChatSession()
standalone.appendUser('帮我查一下待审核的用户')

// 模拟后端的流式响应（chat.completion.chunk）
;['共找到 ', '2 位', '待审核用户。'].forEach(text => {
  standalone.applyChunk({ choices: [{ delta: { role: 'assistant', content: text } }] })
})
standalone.applyChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] })

render(standalone)
console.log(`\n  状态: ${standalone.state.status}`)
console.log('  导出为下一轮请求的 messages:')
console.log('   ', JSON.stringify(standalone.toMessages()))

// ══ 用法二：接上核心运行时，写操作过闸门 ════════════════════════════
line('【用法二】接上 AgentRuntime —— 同一个会话，写操作被闸门拦住')

const db = new Map([['u_1', { id: 'u_1', name: '张三', status: '待审核' }]])

const userModule: ModuleDefinition = {
  id: 'user', title: '用户管理', description: '查询与删除用户',
  aliases: ['用户'], routes: ['UserList'], permissions: [],
  prompt: '按条件操作用户', examples: [], formatContext: () => ''
}

const deleteUser = defineWriteTool({
  moduleId: 'user', name: 'delete', version: 1, owner: 'user-team',
  lifecycle: { status: 'active' },
  title: '删除用户', description: '删除指定用户',
  aliases: [], permissions: [], risk: 'destructive', executionMode: 'global',
  schema: Type.Object({ id: Type.String() }, { additionalProperties: false }),
  prepare: async (_ctx, input: { id: string }) => ({
    title: '确认删除用户',
    rows: [{ label: '用户', value: db.get(input.id)?.name ?? '(未知)' }],
    impact: '删除后不可恢复',
    rawRequest: { method: 'DELETE', url: `/api/users/${input.id}` },
    payload: { id: input.id }
  }),
  execute: async (_ctx, prepared: { id: string }) => {
    db.delete(prepared.id)
    return { ok: true, message: '已删除', writeState: 'committed' as const }
  }
})

const queryUsers = defineReadTool({
  moduleId: 'user', name: 'query', version: 1, owner: 'user-team',
  lifecycle: { status: 'active' },
  title: '查询用户', description: '查询用户列表',
  aliases: [], permissions: [], risk: 'read', executionMode: 'global',
  schema: Type.Object({}, { additionalProperties: false }),
  execute: async () => ({ ok: true, message: `命中 ${db.size} 条` })
})

function toolCall(id: string, name: string, args: unknown): LlmAssistantMessage {
  return {
    role: 'assistant', content: null,
    tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) }}]
  }
}

const adapters = new PageAdapterRegistry()
const handlers: Array<(event: RuntimeUiEventLike) => void> = []

/**
 * 记住模型最近一轮发起的工具调用。
 *
 * 核心的 `RuntimeUiEvent` 不带 `tool_calls`，宿主需要自己从模型响应里捕获再补给
 * 桥接层——否则导出的历史里 tool 消息没有发起者，OpenAI 协议下非法。
 */
let lastToolCalls: Array<{ id: string, type: 'function', function: { name: string, arguments: string } }> | undefined
const scripted = new FakeLlm([
  toolCall('c1', 'user_delete_v1', { id: 'u_1' }),
  { role: 'assistant', content: '已删除张三。' }
])
const llm = {
  async chat(...args: Parameters<FakeLlm['chat']>) {
    const reply = await scripted.chat(...args)
    lastToolCalls = reply.tool_calls
    return reply
  }
}

const runtime = new AgentRuntime({
  llm,
  registry: createToolRegistry([userModule], [queryUsers, deleteUser]),
  resolveCandidates,
  composePrompt: composePromptMessages,
  actionRouter: new ActionRouter({
    adapters,
    navigation: new NavigationCoordinator(
      { getCurrentRouteName: () => 'UserList', push: async () => undefined },
      adapters
    ),
    resolveRouteName: () => 'UserList'
  }),
  getRouteName: () => 'UserList',
  getPermissions: () => [],
  getPageContext: () => null,
  // 运行时的事件出口就是这个 emit，桥接层从这里接管。
  //
  // assistant 事件要补上本轮的 tool_calls：核心的 RuntimeUiEvent 不带这个字段，
  // 而缺了它，随后的 tool 结果在导出历史里会成为没有发起者的孤儿——OpenAI 协议
  // 要求每条 tool 消息都由某个 tool_calls 发起。
  emit: event => {
    const enriched = event.type === 'assistant'
      ? { ...event, toolCalls: lastToolCalls }
      : event
    handlers.forEach(handler => handler(enriched as RuntimeUiEventLike))
  }
}, { traces: undefined as never })

const session = new ChatSession()
const controls = connectRuntime(session, runtime, {
  onEvent: handler => handlers.push(handler)
})

await controls.send('把张三删掉')
render(session)
console.log(`\n  数据库仍有 u_1: ${db.has('u_1')}   ← 还没删，在等人`)

console.log('\n  >> 用户点击【确认执行】')
await controls.approve(session.state.confirmation?.confirmationId as string)

render(session)
console.log(`\n  终态: ${session.state.status}｜数据库仍有 u_1: ${db.has('u_1')}`)

line('两种用法共用同一个 ChatSession 与同一套 OpenAI 协议')
