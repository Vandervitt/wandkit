/**
 * 页面原语模式的提示词回归 —— 接真实模型。
 *
 * 复现的是真实接入中实测到的三个缺陷（aicc 后台，GLM-4-Flash）：
 *
 * 1. 中文提问，助手用英文作答。
 * 2. 「帮我查询今天有多少话单」——首页快照里明明有 `button 话单查询`，模型却回答
 *    「找不到能查话单的工具或元素」，读了一次页面就放弃，**不会导航**。
 * 3. 「你有哪些工具呢」——把 `page_click_v1` 这类内部函数名逐条念给用户听。
 *
 * 排查下来根因有三层，**真正致命的是前两层，不是提示词**：
 *
 * - **快照读不到正文。** 只收可交互元素，「今日话单合计 1842 条」在 `<p>` 里，模型
 *   结构性失明。见 `snapshot.ts` 的 `TextBlock`。
 * - **可纠正的失败会判死整个 Run。** 模型第一步没读页面就点击，拿到一句「工具运行
 *   失败，请稍后重试」，Run 当场结束。见 `ToolResult.retryable`。
 * - **提示词是为声明式业务工具写的。** 「建议的下一步必须有本轮真实暴露的工具支撑」
 *   在页面原语模式下会把能力边界误判成工具列表；也没有语言约束和导航策略。
 *
 * 修完前两层之后，**旧提示词在本场景下同样能通过**——提示词的收益是路径更短、少一次
 * 无效点击，而不是「能不能做成」。本例保留两种模式正是为了让这个区别可测：
 *
 *   npm run example:page-prompt          # 新提示词（PAGE_AGENT_SYSTEM_PROMPT）
 *   npm run example:page-prompt -- old   # 旧提示词
 *
 * 需要 .env 里的 LLM_API_KEY，见 examples/README.md。
 */
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import {
  AgentRuntime,
  ActionRouter,
  NavigationCoordinator,
  PageAdapterRegistry,
  createToolRegistry,
  resolveCandidates,
  createPromptComposer,
  DEFAULT_SYSTEM_PROMPT,
  type LlmAssistantMessage,
  type LlmMessage,
  type ModuleDefinition
} from '../packages/core/src/index'

// ── 配置 ─────────────────────────────────────────────────────────────
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
const USE_OLD_PROMPT = process.argv.includes('old')

if (!API_KEY) {
  console.error('\n缺少 LLM_API_KEY。cp .env.example .env 后填入。\n')
  process.exit(1)
}

// ── 一个双页后台：首页有入口，话单在另一页 ───────────────────────────
//
// 这是缺陷 2 的关键结构：目标数据**不在当前页**。声明式工具是全局可用的，
// 感觉不到这个问题；页面原语被当前页面框住，不导航就永远够不到。
interface PageSpec {
  heading: string
  paragraph: string
  buttons: string[]
}

const HOME: PageSpec = {
  heading: '首页',
  paragraph: '客户数量 75　坐席数量 1766　话术数量 236',
  buttons: ['客户管理', '话术管理', '话单查询', '数据报表']
}

const CALL_RECORDS: PageSpec = {
  heading: '话单查询',
  paragraph: '今日话单合计 1842 条，其中已接通 1130 条。',
  buttons: ['返回首页']
}

const dom = new JSDOM(
  '<!doctype html><html><body><div id="app"></div></body></html>',
  { url: 'https://admin.example.com/index' }
)

const globalScope = globalThis as Record<string, unknown>
globalScope.window = dom.window
globalScope.document = dom.window.document
globalScope.location = dom.window.location
globalScope.Event = dom.window.Event
globalScope.HTMLElement = dom.window.HTMLElement
globalScope.getComputedStyle = dom.window.getComputedStyle.bind(dom.window)

const doc = dom.window.document
const app = doc.getElementById('app')!

/**
 * 渲染一页，并接上真实的路由行为：点入口就换整页内容，索引随之全部失效。
 *
 * 用 DOM API 逐个建节点而不是 innerHTML——页面文案在真实系统里来自业务数据，
 * 样例不该示范把它当 HTML 拼进去。
 */
function render(spec: PageSpec): void {
  const heading = doc.createElement('h1')
  heading.textContent = spec.heading
  const paragraph = doc.createElement('p')
  paragraph.textContent = spec.paragraph

  const buttons = spec.buttons.map(label => {
    const button = doc.createElement('button')
    button.textContent = label
    button.addEventListener('click', () => {
      if (label === '话单查询') render(CALL_RECORDS)
      else if (label === '返回首页') render(HOME)
      else render({ heading: label, paragraph: '此页暂无数据。', buttons: ['返回首页'] })
      console.log(`  【页面】已跳转到「${label}」`)
    })
    return button
  })

  app.replaceChildren(heading, paragraph, ...buttons)
}

render(HOME)

// 必须在注入 document 之后再导入，模块顶层会读全局
const { createPageTools, PAGE_AGENT_SYSTEM_PROMPT } =
  await import('../packages/executor/src/index')

// ── 只声明原语 ───────────────────────────────────────────────────────
const pageModule: ModuleDefinition = {
  id: 'page',
  title: '页面操作',
  description: '读取并操作当前页面上的任意元素',
  aliases: ['页面'],
  routes: ['*'],
  permissions: [],
  prompt: '通过读取页面、点击、输入完成用户请求。',
  examples: [],
  formatContext: () => ''
}

async function chat(
  messages: LlmMessage[],
  tools: unknown[],
  signal?: AbortSignal
): Promise<LlmAssistantMessage> {
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
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

let reply = ''

function createRuntime() {
  const registry = createToolRegistry(
    [pageModule],
    createPageTools({ moduleId: 'page', owner: 'demo' })
  )
  const adapters = new PageAdapterRegistry()

  return new AgentRuntime({
    llm: { chat },
    registry,
    resolveCandidates,
    composePrompt: createPromptComposer({
      systemPrompt: USE_OLD_PROMPT ? DEFAULT_SYSTEM_PROMPT : PAGE_AGENT_SYSTEM_PROMPT,
      timeZone: 'Asia/Shanghai'
    }),
    actionRouter: new ActionRouter({
      adapters,
      navigation: new NavigationCoordinator(
        { getCurrentRouteName: () => '*', push: async () => undefined },
        adapters
      ),
      resolveRouteName: () => '*'
    }),
    getRouteName: () => '*',
    getPermissions: () => [],
    getPageContext: () => null,
    // 导航型任务比单页任务多绕两轮：读首页 → 点入口 → 再读 → 作答
    maxRounds: 10,
    maxToolCalls: 12,
    runTimeoutMs: 120000,
    emit: event => {
      if (event.type === 'assistant' && event.content) {
        reply = event.content
      }
      if (event.type === 'tool_result' && event.result && !event.result.ok) {
        console.log(`  ✗ ${event.result.message}`)
      }
    }
  })
}

// ── 跑一遍 ───────────────────────────────────────────────────────────
const QUESTION = '帮我查询今天有多少话单'

console.log(
  `提示词: ${USE_OLD_PROMPT
    ? 'DEFAULT_SYSTEM_PROMPT（为声明式工具设计）'
    : 'PAGE_AGENT_SYSTEM_PROMPT（新）'}`
)
console.log(`模型: ${MODEL}`)
console.log(`\n用户说：「${QUESTION}」\n`)

const runtime = createRuntime()
const snapshot = await runtime.start(QUESTION)

console.log(`\n  🤖 ${reply}`)
console.log(`\n  Run 终态: ${snapshot.status}`)

// 模型实际调了哪些工具只有 trace 里有——事件流里没有 tool_call 这一类。
const called = runtime.traces.recent().flatMap(trace =>
  trace.events.filter(e => e.type === 'model_response').flatMap(e => e.names ?? [])
)
console.log(`  模型调用: ${called.join(' → ') || '（无）'}`)

// ── 断言 ─────────────────────────────────────────────────────────────
//
// 三条对应三个实测缺陷。断言的是**可观察的行为**，不是提示词文本——提示词写了
// 什么不重要，模型照不照做才重要。
const checks = [
  {
    name: '导航到了话单页（缺陷 2）',
    // 只看页面最终状态：模型走哪条路不重要，到没到目标页才重要。
    pass: (app.textContent ?? '').includes('话单合计')
  },
  {
    name: '答案里给出了真实数字 1842（缺陷 2）',
    pass: reply.includes('1842')
  },
  {
    name: '用中文回复（缺陷 1）',
    pass: /[一-龥]/.test(reply)
  },
  {
    name: '没有把内部工具名说给用户（缺陷 3）',
    pass: !/page_(read|click|input|select|scroll)_v\d/.test(reply)
  }
]

console.log(`\n${'─'.repeat(60)}`)
checks.forEach(check => console.log(`  ${check.pass ? '✓' : '✗'} ${check.name}`))

const failed = checks.filter(check => !check.pass).length
console.log(`\n  ${failed === 0 ? '全部通过' : `${failed} 项未通过`}\n`)
process.exit(failed === 0 ? 0 : 1)
