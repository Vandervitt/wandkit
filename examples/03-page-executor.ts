/**
 * 自动化能力发现 —— 零业务工具声明。
 *
 * 与 01/02 的根本区别：**这里没有声明任何业务工具**。没有「查询用户」，没有
 * 「删除用户」。只注册了 4 个通用原语（读页面、点击、输入、选择）。
 *
 * Agent 靠读取页面自己发现能做什么，然后按索引操作——能力不再需要枚举。
 *
 * 运行：npm run example:page
 *
 * ⚠ 注意本例中删除**没有经过任何确认**。这正是当前进度的真实状态：能力先跑通，
 * 闸门由后续的请求层拦截器提供。别照这个样子上生产。
 */
import { JSDOM } from 'jsdom'
import {
  AgentRuntime,
  ActionRouter,
  NavigationCoordinator,
  PageAdapterRegistry,
  createToolRegistry,
  resolveCandidates,
  composePromptMessages,
  type LlmAssistantMessage,
  type ModuleDefinition
} from '../packages/core/src/index'
import { FakeLlm } from '../packages/core/src/testing/fakeLlm'

// ── 搭一个假的后台页面 ────────────────────────────────────────────────
const dom = new JSDOM(`<!doctype html><html><body>
  <h1>用户管理</h1>
  <label for="kw">关键词</label>
  <input id="kw" type="text">
  <select aria-label="状态">
    <option value="">全部</option>
    <option value="pending">待审核</option>
  </select>
  <button>查询</button>
  <table>
    <tr><td>张三</td><td><button aria-label="删除用户 张三">删除</button></td></tr>
    <tr><td>李四</td><td><button aria-label="删除用户 李四">删除</button></td></tr>
  </table>
</body></html>`, { url: 'https://admin.example.com/users' })

const globalScope = globalThis as Record<string, unknown>
globalScope.window = dom.window
globalScope.document = dom.window.document
globalScope.location = dom.window.location
globalScope.Event = dom.window.Event
globalScope.HTMLElement = dom.window.HTMLElement

// 真实的「后端」：删除按钮点下去就少一行
dom.window.document.querySelectorAll('button[aria-label^="删除"]').forEach(button => {
  button.addEventListener('click', () => {
    button.closest('tr')?.remove()
    console.log(`  【页面】${button.getAttribute('aria-label')} —— 该行已移除`)
  })
})

// 必须在注入 document 之后再导入，模块顶层会读全局
const { createPageTools } = await import('../packages/executor/src/index')

// ── 只声明原语，不声明任何业务能力 ────────────────────────────────────
const pageModule: ModuleDefinition = {
  id: 'page',
  title: '页面操作',
  description: '读取并操作当前页面上的任意元素',
  aliases: ['页面'],
  routes: ['*'],
  permissions: [],
  prompt: '通过读取页面、点击、输入来完成用户请求。每次操作前先读取页面。',
  examples: [],
  formatContext: () => ''
}

const tools = createPageTools({ moduleId: 'page', owner: 'platform' })
console.log('已注册的工具（全部是通用原语，没有一个业务能力）：')
tools.forEach(tool => console.log(`  - ${tool.moduleId}_${tool.name}_v${tool.version}  ${tool.title}`))

const registry = createToolRegistry([pageModule], tools)

// ── 回放一段「模型自己摸索」的过程 ────────────────────────────────────
function call(id: string, name: string, args: unknown): LlmAssistantMessage {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) }}]
  }
}

const llm = new FakeLlm([
  call('c1', 'page_read_v1', {}),
  call('c2', 'page_click_v1', { index: 3 }),
  call('c3', 'page_read_v1', {}),
  { role: 'assistant', content: '已删除张三，当前列表只剩李四。' }
])

const adapters = new PageAdapterRegistry()
const runtime = new AgentRuntime({
  llm,
  registry,
  resolveCandidates,
  composePrompt: composePromptMessages,
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
  emit: event => {
    if (event.type === 'tool_result' && event.result?.data) {
      console.log('\n  【模型看到的页面】')
      String(event.result.data).split('\n').forEach(line => console.log('    ' + line))
    } else if (event.type === 'tool_result') {
      console.log(`  【动作】${event.result?.message}`)
    } else if (event.type === 'assistant' && event.content) {
      console.log(`\n  【回复】${event.content}`)
    }
  }
}, { traces: undefined as never })

console.log('\n用户输入：把张三删掉\n')
const snapshot = await runtime.start('把张三删掉')

console.log(`\n终态：${snapshot.status}`)
console.log('页面剩余行：', [...dom.window.document.querySelectorAll('table tr')]
  .map(row => row.querySelector('td')?.textContent).join('、'))
