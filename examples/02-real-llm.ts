/**
 * 接真实大模型的样例。
 *
 * 与 `01-fake-llm.ts` 的区别只有一处：LLM 不再是脚本里写死的回放，而是真的在推理。
 * 挑哪个工具、从「把张三删掉」里解析出哪个 id、要不要追问，全由模型决定——而无论它
 * 决定什么，破坏性操作都必须先过闸门。
 *
 * 运行：
 *   cp .env.example .env   # 填入 LLM_API_KEY
 *   npm run example:llm
 *
 * Key 从环境变量读，绝不写进代码。这既是为了不让它进版本库，也是因为本包的核心主张
 * 就是「Key 永远不进前端」——样例不该示范它自己反对的做法。
 */
import { readFileSync } from 'node:fs'
import { Type } from '@sinclair/typebox'
import {
  AgentRuntime,
  ActionRouter,
  NavigationCoordinator,
  PageAdapterRegistry,
  createToolRegistry,
  resolveCandidates,
  createPromptComposer,
  defineReadTool,
  defineWriteTool,
  type LlmAssistantMessage,
  type LlmMessage,
  type ModuleDefinition
} from '../packages/core/src/index'

// ── 读取配置 ─────────────────────────────────────────────────────────
/** 极简 .env 解析：样例不值得为此引一个依赖。 */
function loadEnv(): Record<string, string> {
  const env: Record<string, string> = { ...process.env as Record<string, string> }
  try {
    readFileSync(new URL('../.env', import.meta.url), 'utf8')
      .split('\n')
      .forEach(line => {
        const matched = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/)
        if (matched && !env[matched[1]]) env[matched[1]] = matched[2].trim()
      })
  } catch (_error) {
    // 没有 .env 就只用真实环境变量
  }
  return env
}

const env = loadEnv()
const BASE_URL = env.LLM_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4'
const MODEL = env.LLM_MODEL || 'glm-4-flash'
const API_KEY = env.LLM_API_KEY

if (!API_KEY) {
  console.error(
    '\n缺少 LLM_API_KEY。\n\n' +
    '  cp .env.example .env   然后填入 key\n\n' +
    '推荐智谱 GLM-4-Flash（永久免费、不限量）：https://www.bigmodel.cn/\n'
  )
  process.exit(1)
}

// ── 假的业务数据与后端 ───────────────────────────────────────────────
interface User { id: string, name: string, status: string }

const db = new Map<string, User>([
  ['u_1', { id: 'u_1', name: '张三', status: '待审核' }],
  ['u_2', { id: 'u_2', name: '李四', status: '待审核' }],
  ['u_3', { id: 'u_3', name: '王五', status: '已通过' }]
])

// ── 模块与工具 ───────────────────────────────────────────────────────
const userModule: ModuleDefinition<{ users: User[] }> = {
  id: 'user',
  title: '用户管理',
  description: '查询用户列表、查看用户详情、删除用户',
  aliases: ['用户', '客户'],
  routes: ['UserList'],
  permissions: ['user:manage'],
  prompt: [
    '用户 id 形如 u_1。用户只会说姓名，不会说 id。',
    '需要按姓名定位某个用户时，先调用查询工具拿到 id，再执行后续操作。',
    '不要凭空构造 id。'
  ].join('\n'),
  examples: ['查询待审核用户', '把张三删掉'],
  // 页面上下文：让模型知道当前屏幕上有什么，省掉一次查询往返
  formatContext: ctx => ctx.users
    .map(u => `${u.id} ${u.name} ${u.status}`)
    .join('\n')
}

const queryUsers = defineReadTool({
  moduleId: 'user',
  name: 'query',
  version: 1,
  owner: 'demo',
  lifecycle: { status: 'active' },
  title: '查询用户',
  description: '按状态查询用户列表。status 可选值：待审核、已通过。不传则返回全部。',
  aliases: ['查用户', '用户列表'],
  permissions: ['user:manage'],
  risk: 'read',
  executionMode: 'global',
  schema: Type.Object(
    { status: Type.Optional(Type.String({ description: '用户状态，如「待审核」' })) },
    { additionalProperties: false }
  ),
  execute: async(_ctx, input: { status?: string }) => {
    const rows = [...db.values()].filter(u => !input.status || u.status === input.status)
    console.log(`      ↳ 执行查询 status=${input.status ?? '全部'} → ${rows.length} 条`)
    return { ok: true, message: `命中 ${rows.length} 条`, data: rows }
  }
})

const deleteUser = defineWriteTool({
  moduleId: 'user',
  name: 'delete',
  version: 1,
  owner: 'demo',
  lifecycle: { status: 'active' },
  title: '删除用户',
  description: '删除指定 id 的用户。这是不可恢复的操作。',
  aliases: ['删用户', '删除'],
  permissions: ['user:manage'],
  risk: 'destructive',
  executionMode: 'global',
  schema: Type.Object(
    { id: Type.String({ description: '用户 id，形如 u_1' }) },
    { additionalProperties: false }
  ),
  prepare: async(_ctx, input: { id: string }) => {
    const user = db.get(input.id)
    if (!user) throw new Error(`用户不存在: ${input.id}`)
    console.log(`      ↳ prepare（只造卡片，不写库）id=${input.id}`)
    return {
      title: '确认删除用户',
      rows: [
        { label: '用户', value: user.name },
        { label: 'ID', value: user.id },
        { label: '状态', value: user.status }
      ],
      impact: '删除后不可恢复',
      payload: { id: user.id }
    }
  },
  execute: async(_ctx, prepared: { id: string }) => {
    db.delete(prepared.id)
    console.log(`      ↳ execute（真正写库）id=${prepared.id}`)
    return { ok: true, message: '已删除', writeState: 'committed' as const }
  }
})

// ── 接真实模型 ───────────────────────────────────────────────────────
/**
 * 生产环境这里应当指向**你自己的后端**，由后端持有 Key。
 * 样例是 Node 脚本，没有浏览器暴露面，才直接调厂商。
 */
async function chat(
  messages: LlmMessage[],
  tools: unknown[],
  signal?: AbortSignal
): Promise<LlmAssistantMessage> {
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`
    },
    body: JSON.stringify({ model: MODEL, messages, tools, temperature: 0 }),
    signal
  })

  if (!response.ok) {
    throw new Error(`LLM ${response.status}: ${(await response.text()).slice(0, 300)}`)
  }
  const payload = await response.json() as {
    choices?: Array<{ message?: LlmAssistantMessage }>
  }
  const message = payload.choices?.[0]?.message
  if (!message) throw new Error('LLM 返回结构异常')
  return { role: 'assistant', content: message.content ?? null, tool_calls: message.tool_calls }
}

function createRuntime() {
  const registry = createToolRegistry([userModule], [queryUsers, deleteUser])
  const adapters = new PageAdapterRegistry()
  const router = { getCurrentRouteName: () => 'UserList', push: async() => undefined }

  return new AgentRuntime({
    llm: { chat },
    registry,
    resolveCandidates,
    // 中文场景把时区钉死，否则「今天」会飘
    composePrompt: createPromptComposer({ timeZone: 'Asia/Shanghai' }),
    actionRouter: new ActionRouter({
      adapters,
      navigation: new NavigationCoordinator(router, adapters),
      resolveRouteName: moduleId => registry.modules.get(moduleId)?.routes[0]
    }),
    getRouteName: () => 'UserList',
    getPermissions: () => ['user:manage'],
    getPageContext: async() => ({ users: [...db.values()] }),
    emit: event => {
      if (event.type === 'confirmation' && event.confirmation) {
        const c = event.confirmation
        console.log(`\n  ┌─ 确认卡片 [${c.risk}] ${c.title}`)
        c.rows.forEach(r => console.log(`  │  ${r.label}: ${r.value}`))
        if (c.impact) console.log(`  │  ⚠ ${c.impact}`)
        console.log('  └─ 等待人工决定…')
      }
      if (event.type === 'tool_result' && event.result) {
        console.log(`      ↳ 结果 ok=${event.result.ok} ${event.result.message}`)
      }
      if (event.type === 'assistant' && event.content) {
        console.log(`\n  🤖 ${event.content}`)
      }
    }
  })
}

function snapshot(): string {
  return [...db.values()].map(u => `${u.name}(${u.status})`).join('、') || '（空）'
}

// ── 场景 ─────────────────────────────────────────────────────────────
async function run(title: string, input: string, decide?: 'approve' | 'reject') {
  console.log(`\n${'─'.repeat(66)}\n【${title}】用户说：「${input}」`)
  const runtime = createRuntime()
  let snap = await runtime.start(input)

  const pending = runtime.currentConfirmation()
  if (pending) {
    if (decide === 'approve') {
      console.log('  >> 用户点击【确认删除】')
      snap = await runtime.confirm(pending.confirmationId)
    } else {
      console.log('  >> 用户点击【取消】')
      snap = await runtime.cancel(pending.confirmationId)
    }
  }

  console.log(`\n  Run 终态: ${snap.status}`)
  console.log(`  数据库: ${snapshot()}`)
  return runtime
}

console.log(`模型: ${MODEL}  @  ${BASE_URL}`)
console.log(`初始数据: ${snapshot()}`)

// 1. 读操作：模型自己决定调查询工具，静默执行
await run('读操作', '有哪些待审核的用户？')

// 2. 写操作被批准：模型要从「张三」推出 u_1，然后被闸门拦下
await run('写操作 · 批准', '把张三这个用户删掉', 'approve')

// 3. 写操作被拒绝：拒绝会回喂给模型，它应当停止而不是换个参数重试
const rejected = await run('写操作 · 拒绝', '再把李四也删了', 'reject')

// 4. 审计轨迹
console.log(`\n${'─'.repeat(66)}\n【审计】最后一次 Run 的事件序列`)
rejected.traces.recent().slice(-1).forEach(trace => {
  trace.events.forEach(e => {
    const detail = [e.functionName, e.decision, e.names?.join(',')]
      .filter(Boolean).join(' ')
    console.log(`  ${e.type.padEnd(18)} ${detail}`)
  })
})
console.log()
