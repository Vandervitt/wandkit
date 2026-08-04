/**
 * Run 失败必须能被界面看见——接真实模型的集成测试。
 *
 * 真实接入实测出来的缺陷：用户发一句话，转几秒，屏幕上什么都没多出来，输入框解锁。
 * 看起来像「Agent 不回复」，实际是 Run 已经失败了，而**失败原因根本传不到界面**：
 * `finish()` 把 reason 只写进 trace，`publishState()` 发出的 `state` 事件里没有这个
 * 字段，于是消费方（`@wandkit/chat` 的桥接层）除了「状态变成 failed」以外什么
 * 都拿不到，只能静静地把界面切回 idle。
 *
 * 这里刻意用真实厂商接口而不是 `FakeLlm`：回放式单测的响应正是写测试的人想象中的
 * 响应，而这个缺陷的触发条件（真实的 401、真实的多轮绕路、真实的空 content）恰恰
 * 是想象不出来的。缺了这一层，缺陷就是这么逃出去的。
 *
 * 没有 `LLM_API_KEY` 时整组跳过——空跑比红灯更危险。
 */
import { Type } from '@sinclair/typebox'
import { describe, expect, it } from 'vitest'
import { defaultMessages } from '../config/messages'
import type { LlmMessage } from '../contracts/llm'
import { defineReadTool } from '../contracts/tool'
import type { ActionRouter } from '../execution/actionRouter'
import { createToolRegistry } from '../registry/toolRegistry'
import { createRealLlm, hasRealLlm, REAL_LLM_MODEL } from '../testing/realLlmClient'
import {
  AgentRuntime,
  type AgentRuntimeDependencies,
  type RuntimeUiEvent
} from './agentRuntime'

/** 真实模型要走网络，每个用例给足时间。 */
const NETWORK_TIMEOUT_MS = 90000

const gatewayModule = {
  id: 'gateway',
  title: '线路管理',
  description: '查询线路列表',
  aliases: ['线路'],
  routes: ['GatewayList'],
  permissions: ['gateway:use'],
  prompt: '查询线路信息时必须调用 gateway_query_v1 工具，不要凭记忆回答。',
  examples: ['查询线路'],
  formatContext: () => ''
}

const queryTool = defineReadTool({
  moduleId: 'gateway',
  name: 'query',
  version: 1,
  owner: 'test',
  lifecycle: { status: 'active' },
  title: '查询线路',
  description: '查询线路列表。查询线路相关信息时必须调用本工具。',
  aliases: ['查线路'],
  permissions: ['gateway:use'],
  risk: 'read' as const,
  executionMode: 'global' as const,
  schema: Type.Object(
    { keyword: Type.Optional(Type.String({ description: '线路名关键字' })) },
    { additionalProperties: false }
  ),
  execute: async() => ({ ok: true, message: '命中 1 条', data: [{ id: 'g_1', name: '默认线路' }] })
})

interface Harness {
  runtime: AgentRuntime
  events: RuntimeUiEvent[]
  /** 终态那一次 `state` 事件——界面正是靠它决定「这一轮结束了」。 */
  terminalState(): RuntimeUiEvent | undefined
}

function createHarness(
  overrides: Partial<AgentRuntimeDependencies> = {},
  options?: ConstructorParameters<typeof AgentRuntime>[1]
): Harness {
  const registry = createToolRegistry([gatewayModule], [queryTool])
  const events: RuntimeUiEvent[] = []
  const dependencies: AgentRuntimeDependencies = {
    llm: createRealLlm(),
    registry,
    resolveCandidates: () => ['gateway'],
    composePrompt: async({ history }) => history as LlmMessage[],
    actionRouter: {
      execute: async() => ({ ok: true, message: '命中 1 条' })
    } as unknown as ActionRouter,
    getRouteName: () => 'GatewayList',
    getPermissions: () => ['gateway:use'],
    getPageContext: async() => null,
    emit: event => events.push(event),
    ...overrides
  }
  const runtime = new AgentRuntime(dependencies, options)
  const terminal = new Set(['completed', 'failed', 'cancelled'])
  return {
    runtime,
    events,
    terminalState: () => [...events]
      .reverse()
      .find(event => event.type === 'state' && terminal.has(event.snapshot?.status ?? ''))
  }
}

describe.skipIf(!hasRealLlm)(`Run 终态原因对界面可见（真实模型 ${REAL_LLM_MODEL}）`, () => {
  it('模型调用失败时，终态事件必须带上失败原因', async() => {
    // 真实厂商接口 + 无效 Key = 真实的鉴权失败。这是接入方最常踩的一脚（后端没起、
    // Key 过期、闸门把模型请求当写操作拦了），而它当前的界面表现是「什么都没发生」。
    const { runtime, terminalState } = createHarness({
      llm: createRealLlm({ apiKey: 'sk-invalid-on-purpose' })
    })

    const snapshot = await runtime.start('查一下线路列表')

    expect(snapshot.status).toBe('failed')
    const state = terminalState()
    expect(state?.snapshot?.status).toBe('failed')
    expect(state?.stopReason).toBeTruthy()
  }, NETWORK_TIMEOUT_MS)

  it('失败原因里要留下真实错误的线索，而不是只有一句通用文案', async() => {
    // 只发 `runFailed` 那句「请稍后重试」，等于把唯一有用的信息（HTTP 401）丢掉，
    // 接入方只能靠猜。原始错误必须至少能在原因里看到。
    const { runtime, terminalState } = createHarness({
      llm: createRealLlm({ apiKey: 'sk-invalid-on-purpose' })
    })

    await runtime.start('查一下线路列表')

    const reason = terminalState()?.stopReason ?? ''
    expect(reason).toContain(defaultMessages.runFailed)
    expect(reason).toMatch(/LLM \d{3}/)
  }, NETWORK_TIMEOUT_MS)

  it('撞上工具调用预算时，终态事件必须说明是撞了预算', async() => {
    // 真实模型会自己决定调工具；预算设为 0，它一伸手就被挡住。用户看到的不该是
    // 「没有回复」，而该是「这一轮用光了预算」。
    const { runtime, terminalState } = createHarness({}, { maxToolCalls: 0 })

    const snapshot = await runtime.start('查询线路列表，必须调用工具')

    // 模型偶尔会不调工具直接作答，那条路径是 completed，与本用例无关。
    if (snapshot.status === 'completed') {
      expect(terminalState()?.stopReason).toBeUndefined()
      return
    }
    expect(snapshot.status).toBe('failed')
    expect(terminalState()?.stopReason).toContain('0')
  }, NETWORK_TIMEOUT_MS)

  it('正常完成的 Run 不带失败原因', async() => {
    const { runtime, terminalState } = createHarness()

    const snapshot = await runtime.start('你好，请直接回答「收到」两个字')

    expect(snapshot.status).toBe('completed')
    expect(terminalState()?.stopReason).toBeUndefined()
  }, NETWORK_TIMEOUT_MS)
})
