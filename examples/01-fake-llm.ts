/**
 * 可运行的最小接入示例。
 *
 * 用 FakeLlm 代替真实模型，让整条链路在终端里确定性地跑一遍：
 * 读工具静默执行 → 写工具挂起等确认 → 确认后执行 → 数据变更后拒绝执行。
 *
 * 运行：npx vite-node examples/minimal.ts
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
  type ModuleDefinition
} from '../packages/core/src/index'
import { FakeLlm } from '../packages/core/src/testing/fakeLlm'

// ── 1. 假的业务数据与后端 ────────────────────────────────────────────
const db = new Map([
  ['u_1', { id: 'u_1', name: '张三', status: '待审核' }],
  ['u_2', { id: 'u_2', name: '李四', status: '待审核' }]
])

// ── 2. 定义模块 ──────────────────────────────────────────────────────
const userModule: ModuleDefinition<{ visibleIds: string[] }> = {
  id: 'user',
  title: '用户管理',
  description: '查询与管理用户',
  aliases: ['用户'],
  routes: ['UserList'],
  permissions: ['user:manage'],
  prompt: '按用户模块契约调用工具。删除前必须先确认目标存在。',
  examples: ['查询待审核用户', '删除张三'],
  formatContext: ctx => `当前页面可见用户：${ctx.visibleIds.join('、')}`
}

// ── 3. 定义工具 ──────────────────────────────────────────────────────
const queryUsers = defineReadTool({
  moduleId: 'user',
  name: 'query',
  version: 1,
  owner: 'user-team',
  lifecycle: { status: 'active' },
  title: '查询用户',
  description: '按状态查询用户列表',
  aliases: ['查用户'],
  permissions: ['user:manage'],
  risk: 'read',                 // ← 读：静默执行
  executionMode: 'global',
  schema: Type.Object({ status: Type.String() }, { additionalProperties: false }),
  execute: async(_ctx, input: { status: string }) => {
    const rows = [...db.values()].filter(u => u.status === input.status)
    return { ok: true, message: `命中 ${rows.length} 条`, data: rows }
  }
})

const deleteUser = defineWriteTool({
  moduleId: 'user',
  name: 'delete',
  version: 1,
  owner: 'user-team',
  lifecycle: { status: 'active' },
  title: '删除用户',
  description: '删除指定用户',
  aliases: ['删用户'],
  permissions: ['user:manage'],
  risk: 'destructive',          // ← 破坏性：强制人工确认
  executionMode: 'global',
  schema: Type.Object({ id: Type.String() }, { additionalProperties: false }),

  // 只准备确认内容，绝不写库。可被安全地调用多次。
  prepare: async(_ctx, input: { id: string }) => {
    const user = db.get(input.id)
    if (!user) throw new Error(`用户不存在: ${input.id}`)
    return {
      title: '确认删除用户',
      rows: [
        { label: '用户', value: user.name },
        { label: '状态', value: user.status }
      ],
      impact: '删除后不可恢复',
      payload: { id: user.id }
    }
  },

  // 只有 Runtime 在用户批准 + 重跑比对通过后才会调到这里。
  // 注意签名：拿到的是 prepared payload，拿不到原始 input。
  execute: async(_ctx, prepared: { id: string }) => {
    db.delete(prepared.id)
    return { ok: true, message: '已删除', writeState: 'committed' as const }
  }
})

// ── 4. 组装 Runtime ──────────────────────────────────────────────────
function createRuntime(llm: FakeLlm) {
  const registry = createToolRegistry([userModule], [queryUsers, deleteUser])
  const adapters = new PageAdapterRegistry()
  const router = {
    getCurrentRouteName: () => 'UserList',
    push: async() => undefined
  }

  const events: string[] = []
  const runtime = new AgentRuntime({
    llm,
    registry,
    resolveCandidates,
    composePrompt: composePromptMessages,
    actionRouter: new ActionRouter({
      adapters,
      navigation: new NavigationCoordinator(router, adapters),
      resolveRouteName: moduleId => registry.modules.get(moduleId)?.routes[0]
    }),
    getRouteName: () => 'UserList',
    getPermissions: () => ['user:manage'],   // ← 宿主提供当前用户权限
    getPageContext: async() => ({ visibleIds: [...db.keys()] }),
    emit: e => {
      if (e.type === 'confirmation') {
        events.push(`  [确认卡片] ${e.confirmation!.title}｜风险=${e.confirmation!.risk}`)
        e.confirmation!.rows.forEach(r => events.push(`             ${r.label}: ${r.value}`))
        events.push(`             影响: ${e.confirmation!.impact}`)
      }
      if (e.type === 'tool_result') {
        events.push(`  [工具结果] ok=${e.result!.ok} ${e.result!.message}`)
      }
      if (e.type === 'assistant' && e.content) events.push(`  [回复] ${e.content}`)
    }
  })
  return { runtime, events }
}

const toolCall = (id: string, name: string, args: object) => ({
  role: 'assistant' as const,
  content: null,
  tool_calls: [{ id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }]
})
const text = (content: string) => ({ role: 'assistant' as const, content })

// ── 场景一：读工具，静默执行 ─────────────────────────────────────────
async function scenarioRead() {
  console.log('\n【场景一】查询 —— read 工具，无需确认')
  const { runtime, events } = createRuntime(new FakeLlm([
    toolCall('c1', 'user_query_v1', { status: '待审核' }),
    text('共有 2 位待审核用户。')
  ]))
  const snap = await runtime.start('查一下待审核的用户')
  events.forEach(e => console.log(e))
  console.log(`  终态: ${snap.status}`)
}

// ── 场景二：写工具，挂起 → 确认 → 执行 ───────────────────────────────
async function scenarioWriteConfirm() {
  console.log('\n【场景二】删除 —— destructive 工具，必须人工确认')
  const { runtime, events } = createRuntime(new FakeLlm([
    toolCall('c1', 'user_delete_v1', { id: 'u_1' }),
    text('已删除张三。')
  ]))

  const suspended = await runtime.start('把张三删掉')
  events.forEach(e => console.log(e))
  console.log(`  Run 状态: ${suspended.status}   ← 挂起了，数据还没动`)
  console.log(`  数据库仍有 u_1: ${db.has('u_1')}`)

  const pending = runtime.currentConfirmation()!
  console.log('  >> 用户点击【确认执行】')
  const done = await runtime.confirm(pending.confirmationId)
  events.slice(-2).forEach(e => console.log(e))
  console.log(`  终态: ${done.status}｜数据库仍有 u_1: ${db.has('u_1')}`)
}

// ── 场景三：确认期间数据被改动 → 拒绝执行（TOCTOU 防护）─────────────
async function scenarioStaleConfirmation() {
  console.log('\n【场景三】确认卡片停留期间，数据被别人改了')
  const { runtime, events } = createRuntime(new FakeLlm([
    toolCall('c1', 'user_delete_v1', { id: 'u_2' }),
    text('操作未执行。')
  ]))

  await runtime.start('把李四删掉')
  const pending = runtime.currentConfirmation()!
  console.log(`  [确认卡片] ${pending.rows.map(r => `${r.label}=${r.value}`).join('，')}`)

  console.log('  >> 此时另一个管理员把李四的状态改成了「已通过」')
  db.set('u_2', { ...db.get('u_2')!, status: '已通过' })

  console.log('  >> 用户点击【确认执行】')
  const result = await runtime.confirm(pending.confirmationId)
  events.filter(e => e.includes('工具结果')).forEach(e => console.log(e))
  console.log(`  终态: ${result.status}｜数据库仍有 u_2: ${db.has('u_2')}   ← 拒绝执行`)
}

// ── 场景四：拒绝 ─────────────────────────────────────────────────────
async function scenarioReject() {
  console.log('\n【场景四】用户点【取消】')
  const { runtime, events } = createRuntime(new FakeLlm([
    toolCall('c1', 'user_delete_v1', { id: 'u_2' }),
    text('好的，已取消该删除操作。')
  ]))
  await runtime.start('删掉李四')
  const pending = runtime.currentConfirmation()!
  console.log('  >> 用户点击【取消】')
  const snap = await runtime.cancel(pending.confirmationId)
  events.filter(e => e.includes('工具结果') || e.includes('回复')).forEach(e => console.log(e))
  console.log(`  终态: ${snap.status}｜数据库仍有 u_2: ${db.has('u_2')}`)
}

await scenarioRead()
await scenarioWriteConfirm()
await scenarioStaleConfirmation()
await scenarioReject()
console.log()
