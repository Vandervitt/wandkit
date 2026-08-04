// @vitest-environment node
/**
 * 核心运行时 ↔ 聊天会话的**跨包契约**测试，接真实模型。
 *
 * 为什么必须跨包测：真实接入实测出的「Agent 老是没有回复」，两个包各自的单测都是
 * 绿的——核心确实终止了 Run，桥接层确实按自己声明的字段做了处理。缺陷只存在于两者
 * **之间**：桥接层读 `event.stopReason`，而核心从来不发这个字段。任何只在包内打转的
 * 测试都看不见这个缺口，这就是它逃到真实页面上的原因。
 *
 * 因此本文件是全仓唯一允许同时 import 两个包的测试。注意它 import 的是 **src**，
 * 走相对路径（与 `examples/` 同一做法），因此不给 chat 包添加任何依赖——
 * 「chat 的产物不依赖核心」这条架构约束依然成立，`bridge.ts` 也仍然只用鸭子类型。
 */
import { Type } from '@sinclair/typebox'
import { describe, expect, it } from 'vitest'
import type { LlmMessage } from '../../core/src/contracts/llm'
import { defineReadTool } from '../../core/src/contracts/tool'
import type { ActionRouter } from '../../core/src/execution/actionRouter'
import { createToolRegistry } from '../../core/src/registry/toolRegistry'
import {
  AgentRuntime,
  type AgentRuntimeDependencies,
  type RuntimeUiEvent
} from '../../core/src/runtime/agentRuntime'
import {
  createRealLlm,
  hasRealLlm,
  REAL_LLM_MODEL
} from '../../core/src/testing/realLlmClient'
import { connectRuntime, type RuntimeUiEventLike } from './bridge'
import { ChatSession } from './session'

const NETWORK_TIMEOUT_MS = 90000

const gatewayModule = {
  id: 'gateway',
  title: '线路管理',
  description: '查询线路列表',
  aliases: ['线路'],
  routes: ['GatewayList'],
  permissions: ['gateway:use'],
  prompt: '查询线路信息时必须调用 gateway_query_v1 工具。',
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
  description: '查询线路列表。',
  aliases: ['查线路'],
  permissions: ['gateway:use'],
  risk: 'read' as const,
  executionMode: 'global' as const,
  schema: Type.Object({}, { additionalProperties: false }),
  execute: async() => ({ ok: true, message: '命中 1 条' })
})

/**
 * 按接入文档推荐的方式把两边接起来。
 *
 * `emit` 只补 `toolCalls`（核心的事件确实不带它，README 明确要求宿主补）。
 * **不在这里替核心补 `stopReason`**：那正是要验证的事——宿主没有额外做任何事时，
 * 失败也必须是可见的。
 */
function connect(options: { llm?: AgentRuntimeDependencies['llm'] } = {}) {
  const registry = createToolRegistry([gatewayModule], [queryTool])
  const session = new ChatSession()
  const handlers: Array<(event: RuntimeUiEventLike) => void> = []
  const events: RuntimeUiEvent[] = []
  let lastToolCalls: RuntimeUiEventLike['toolCalls']

  // 按 README 的做法从模型响应里捕获 tool_calls 补给桥接层——核心的事件不带它。
  const upstream = options.llm ?? createRealLlm()
  const llm: AgentRuntimeDependencies['llm'] = {
    async chat(messages, tools, signal) {
      const reply = await upstream.chat(messages, tools, signal)
      lastToolCalls = reply.tool_calls as RuntimeUiEventLike['toolCalls']
      return reply
    }
  }

  const runtime = new AgentRuntime({
    llm,
    registry,
    resolveCandidates: () => ['gateway'],
    composePrompt: async({ history }) => history as LlmMessage[],
    actionRouter: {
      execute: async() => ({ ok: true, message: '命中 1 条' })
    } as unknown as ActionRouter,
    getRouteName: () => 'GatewayList',
    getPermissions: () => ['gateway:use'],
    getPageContext: async() => null,
    emit: event => {
      events.push(event)
      handlers.forEach(handler => handler({
        ...event,
        ...(event.type === 'assistant' ? { toolCalls: lastToolCalls } : {})
      } as RuntimeUiEventLike))
    }
  })

  const controls = connectRuntime(session, runtime, {
    onEvent: handler => handlers.push(handler)
  })
  return { session, runtime, controls, events }
}

describe('运行时与会话的确定性终态契约', () => {
  it('核心结构化失败无宿主补丁时仍对 Chat 可见', async() => {
    const { session, controls, events } = connect({
      llm: {
        chat: async() => { throw new Error('gateway unavailable') }
      }
    })

    await controls.send('查询线路')

    const terminal = events.filter(event =>
      event.type === 'state' && event.snapshot?.status === 'failed').at(-1)
    expect(terminal?.snapshot?.outcome).toMatchObject({
      kind: 'failed',
      error: { code: 'RUNTIME_FAILED' }
    })
    expect(session.state.status).toBe('idle')
    expect(session.state.error).toContain('gateway unavailable')
  })
})

describe.skipIf(!hasRealLlm)(`运行时与会话的契约（真实模型 ${REAL_LLM_MODEL}）`, () => {
  it('模型调用失败时，用户必须在界面上看到失败，而不是一片空白', async() => {
    // 用户视角的复现：发一句话 → 转几秒 → 屏幕上什么都没多出来、输入框解锁。
    // 会话里既没有消息、也没有 error，用户唯一能得到的结论就是「它不理我」。
    const { session, controls } = connect({
      llm: createRealLlm({ apiKey: 'sk-invalid-on-purpose' })
    })


    await controls.send('查一下线路列表')

    expect(session.state.status).toBe('idle')
    expect(session.state.error).toBeTruthy()
  }, NETWORK_TIMEOUT_MS)

  it('模型正常回答时，回答要落进会话', async() => {
    const { session, controls } = connect()

    await controls.send('你好，请直接回答「收到」两个字')

    expect(session.state.error).toBeUndefined()
    expect(session.state.status).toBe('idle')
    const assistantTexts = session.state.entries
      .filter(entry => entry.role === 'assistant')
      .map(entry => entry.content)
    expect(assistantTexts.join('')).not.toBe('')
  }, NETWORK_TIMEOUT_MS)
})
