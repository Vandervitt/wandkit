/**
 * 请求层拦截治理。
 *
 * 演示四件事：
 *
 * 1. **用户自己点的请求不受影响**——归属判定把它们放行
 * 2. **Agent 发起的未知写操作要确认**——默认拒绝，名单只表达例外
 * 3. **已授权窗口内不重复确认**——路径 A 的工具已经问过人了
 * 4. **危险名单优先于放行名单**——宽泛的通配不得盖过高危规则
 *
 * 运行：npm run example:interceptor
 */
import {
  createInterceptor,
  createAuthorizationScope,
  createMaskAttribution,
  runAuthorized,
  RequestDeniedError,
  type InterceptedRequest
} from '../packages/interceptor/src/index'

const line = (title: string): void => console.log(`\n${'─'.repeat(64)}\n${title}\n`)

// ── 模拟浏览器环境 ───────────────────────────────────────────────────
const sent: string[] = []
const globalScope = globalThis as Record<string, unknown>
globalScope.window = globalScope
globalScope.fetch = async (input: unknown, init?: { method?: string }) => {
  sent.push(`${init?.method ?? 'GET'} ${String(input)}`)
  return { ok: true, status: 200 }
}

// ── 归属判定：遮罩武装期间即 Agent 动作窗口 ──────────────────────────
let maskArmed = false
const attribution = createMaskAttribution({ isMaskArmed: () => maskArmed })

// ── 已授权窗口：路径 A 的工具执行期间不重复确认 ──────────────────────
const scope = createAuthorizationScope()

// ── 判定策略：默认拒绝，名单只表达例外 ───────────────────────────────
const policy = {
  danger: [{
    id: 'delete-customer',
    match: { method: 'DELETE', url: '/api/customers/:id' },
    describe: async (request: InterceptedRequest) => ({
      title: '确认删除客户',
      rows: [{ label: '目标', value: request.url.split('/').pop() ?? '' }],
      impact: '删除后不可恢复'
    })
  }],
  allow: [{
    id: 'search',
    // 查询伪装成 POST，这类是已知安全的写
    match: { method: 'POST', url: '/api/*/search' }
  }]
}

const asked: string[] = []
const interceptor = createInterceptor({
  policy,
  attribution,
  authorization: scope,
  confirm: async ({ request, risk, disclosure }) => {
    asked.push(`${risk} ${request.method} ${request.url}`)
    console.log(`  ┌─ ${disclosure?.title ?? '确认操作'}（风险=${risk}）`)
    disclosure?.rows.forEach(row => console.log(`  │  ${row.label}: ${row.value}`))
    console.log(`  │  ${request.method} ${request.url}`)
    console.log('  └─ 用户点击【确认】')
    return true
  },
  onVerdict: (request, verdict) => {
    const rule = verdict.ruleId ? ` [${verdict.ruleId}]` : ''
    console.log(`  · ${request.method} ${request.url} → ${verdict.action}${rule}`)
  }
})
interceptor.install()

// ── 场景一：用户自己的操作 ───────────────────────────────────────────
line('【场景一】用户自己点的删除 —— 遮罩没武装，闸门不管')
maskArmed = false
await fetch('/api/customers/c_1', { method: 'DELETE' })
console.log(`  确认次数: ${asked.length}｜实际发出: ${sent.length}`)

// ── 场景二：Agent 发起的未知写操作 ───────────────────────────────────
line('【场景二】Agent 发起同样的删除 —— 命中危险名单，必须确认')
maskArmed = true
asked.length = 0
await fetch('/api/customers/c_1', { method: 'DELETE' })
console.log(`\n  确认次数: ${asked.length}`)

// ── 场景三：已授权窗口 ───────────────────────────────────────────────
line('【场景三】声明式工具执行期间 —— 人已经在确认卡片上批准过了')
asked.length = 0
await runAuthorized({ scope, token: 'run-1:c1' }, async () => {
  await fetch('/api/customers/c_2', { method: 'DELETE' })
  await fetch('/api/customers/c_2/roles', { method: 'PUT' })
})
console.log(`  窗口内两次写操作，确认次数: ${asked.length}   ← 不重复打扰`)
console.log(`  窗口已关闭: ${!scope.isAuthorized()}`)

// ── 场景四：危险优先于放行 ───────────────────────────────────────────
line('【场景四】放行名单写得宽泛时 —— 危险名单仍然优先')
asked.length = 0
await fetch('/api/customers/search', { method: 'POST' })
console.log(`  查询伪装成 POST：确认次数 ${asked.length}   ← 命中放行名单`)

asked.length = 0
try {
  await fetch('/api/customers/c_3', { method: 'DELETE' })
} catch (error) {
  if (!(error instanceof RequestDeniedError)) throw error
}
console.log(`  删除客户：确认次数 ${asked.length}   ← 危险名单优先，没被放行规则盖住`)

// ── 场景五：默认拒绝 ─────────────────────────────────────────────────
line('【场景五】谁都没命中的写操作 —— 默认拒绝，不是默认放行')
asked.length = 0
await fetch('/api/v2/purge', { method: 'POST' })
console.log(`\n  新上线的接口没人加进名单，确认次数: ${asked.length}`)
console.log('  漏配的代价是多一次确认，而不是静默失去防护。')

line(`全部实际发出的请求（${sent.length} 条）`)
sent.forEach(entry => console.log(`  ${entry}`))
