import { Type } from '@sinclair/typebox'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LlmAssistantMessage, LlmClient, LlmMessage } from '../contracts/llm'
import {
  ToolPreparationError,
  ToolPreparationNotice,
  type PreparedAction,
  type ToolResult
} from '../contracts/result'
import {
  defineReadTool,
  defineWriteTool,
  type ToolDefinition,
  type ToolExecutionContext
} from '../contracts/tool'
import { ActionRouter } from '../execution/actionRouter'
import { PageAdapterRegistry } from '../execution/pageAdapterRegistry'
import { createToolRegistry } from '../registry/toolRegistry'
import { FakeLlm } from '../testing/fakeLlm'
import { AgentRuntime, type AgentRuntimeDependencies } from './agentRuntime'
import { TraceCollector } from './traceCollector'
import { defaultMessages, formatMessage } from '../config/messages'

const gatewayModule = {
  id: 'gateway',
  title: '线路管理',
  description: '管理线路',
  aliases: ['线路'],
  routes: ['Gateway-managemnet'],
  permissions: ['gateway:use'],
  prompt: '只使用真实工具',
  examples: ['查询线路'],
  formatContext: () => ''
}

const readExecute = vi.fn<[ToolExecutionContext, { keyword: string }], Promise<ToolResult>>()
const writePrepare = vi.fn<[ToolExecutionContext, { name: string }], Promise<PreparedAction>>()
const writeExecute = vi.fn<[ToolExecutionContext, unknown], Promise<ToolResult>>()

function createTools() {
  const readTool = defineReadTool({
    moduleId: 'gateway', name: 'query', version: 1, title: '查询', description: '查询线路',
    owner: 'gateway', lifecycle: { status: 'active' },
    aliases: [], permissions: ['gateway:use'], risk: 'read' as const,
    executionMode: 'global' as const,
    schema: Type.Object({ keyword: Type.String() }),
    execute: readExecute
  })
  const writeTool = defineWriteTool({
    moduleId: 'gateway', name: 'update', version: 1, title: '更新', description: '更新线路',
    owner: 'gateway', lifecycle: { status: 'active' },
    aliases: [], permissions: ['gateway:use'], risk: 'write' as const,
    executionMode: 'global' as const,
    schema: Type.Object({ name: Type.String() }),
    prepare: writePrepare,
    execute: writeExecute
  })
  return { readTool, writeTool }
}

function toolReply(...calls: Array<{ id: string, name: string, args: string }>): LlmAssistantMessage {
  return {
    role: 'assistant',
    content: null,
    tool_calls: calls.map(call => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.args }
    }))
  }
}

function finalReply(content = '完成'): LlmAssistantMessage {
  return { role: 'assistant', content }
}

function createRuntime(
  llm: LlmClient,
  overrides: Partial<AgentRuntimeDependencies> = {},
  options?: ConstructorParameters<typeof AgentRuntime>[1]
) {
  const { readTool, writeTool } = createTools()
  const registry = createToolRegistry([gatewayModule], [readTool, writeTool])
  const execute = vi.fn(async(options: {
    tool: ToolDefinition
    prepared?: PreparedAction
  }) => {
    if (options.tool.risk === 'write') {
      return writeExecute({} as ToolExecutionContext, options.prepared?.payload)
    }
    return readExecute({} as ToolExecutionContext, { keyword: '默认' })
  })
  const emit = vi.fn()
  const dependencies: AgentRuntimeDependencies = {
    llm,
    registry,
    resolveCandidates: () => ['gateway'],
    composePrompt: async({ history }) => history as LlmMessage[],
    actionRouter: { execute } as unknown as ActionRouter,
    getRouteName: () => 'Gateway-managemnet',
    getPermissions: () => ['gateway:use'],
    getPageContext: async() => null,
    emit,
    ...overrides
  }
  return { runtime: new AgentRuntime(dependencies, options), execute, emit }
}

describe('AgentRuntime', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('从已恢复 Trace 的最大序号继续生成 Run ID', async() => {
    const traces = new TraceCollector()
    traces.start('run-41', 'trace-41', '历史请求')
    traces.finish('run-41', 'completed')
    const { runtime } = createRuntime(new FakeLlm([finalReply()]), {}, { traces })

    const snapshot = await runtime.start('新请求')

    expect(snapshot).toMatchObject({ runId: 'run-42', traceId: 'trace-42' })
  })

  it('prepare 发现无实际变更时作为正常结果回写模型，不生成确认卡', async() => {
    writePrepare.mockRejectedValueOnce(new ToolPreparationNotice({
      ok: true,
      message: '当前单价已经是 0.2，无需重复修改。可以改为其他单价、查看详情或修改其他字段。'
    }))
    const { runtime, emit } = createRuntime(new FakeLlm([
      toolReply({ id: 'noop-update', name: 'gateway_update_v1', args: '{"name":"same"}' }),
      finalReply('当前值无需修改，你可以继续查看详情。')
    ]))

    const snapshot = await runtime.start('把单价改成当前值')

    expect(snapshot.status).toBe('completed')
    expect(runtime.currentConfirmation()).toBeUndefined()
    expect(writeExecute).not.toHaveBeenCalled()
    expect(runtime.traces.recent()[0].events).toContainEqual(expect.objectContaining({
      type: 'tool_succeeded',
      functionName: 'gateway_update_v1',
      toolCallId: 'noop-update'
    }))
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'assistant',
      content: '当前值无需修改，你可以继续查看详情。'
    }))
  })

  it('发给模型的写工具包含 Runtime 确认语义且读工具保持原描述', async() => {
    const llm = new FakeLlm([finalReply()])
    const { runtime } = createRuntime(llm)

    await runtime.start('查询或更新线路')

    const tools = llm.requests[0].tools as Array<{
      function: { name: string; description: string }
    }>
    const readTool = tools.find(tool => tool.function.name === 'gateway_query_v1')
    const writeTool = tools.find(tool => tool.function.name === 'gateway_update_v1')
    expect(readTool?.function.description).toBe('查询线路')
    expect(writeTool?.function.description).toMatch(
      /only prepares confirmation content.*never performs the write.*confirmation card/s
    )
  })

  it('Trace 记录模型请求可见工具和响应工具选择，不记录参数', async() => {
    const llm = new FakeLlm([
      toolReply({ id: 'trace-call', name: 'gateway_query_v1', args: '{"keyword":"secret"}' }),
      finalReply()
    ])
    readExecute.mockResolvedValueOnce({ ok: true, message: '完成' })
    const { runtime } = createRuntime(llm)

    await runtime.start('查询线路')

    const events = runtime.traces.recent()[0].events
    expect(events).toContainEqual({
      type: 'model_request',
      names: ['gateway_query_v1', 'gateway_update_v1']
    })
    expect(events).toContainEqual({ type: 'model_response', names: ['gateway_query_v1'] })
    expect(JSON.stringify(events)).not.toContain('secret')
  })

  it('读工具返回真实 Tool Result 后继续请求模型', async() => {
    readExecute.mockResolvedValueOnce({ ok: true, message: '查到 1 条', data: [{ id: 1 }] })
    const llm = new FakeLlm([
      toolReply({ id: 'call-read', name: 'gateway_query_v1', args: '{"keyword":"CPV2"}' }),
      finalReply('查询完成')
    ])
    const { runtime, execute } = createRuntime(llm)

    const result = await runtime.start('查询 CPV2 线路')

    expect(result.status).toBe('completed')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(llm.requests).toHaveLength(2)
    expect(llm.requests[1].messages).toContainEqual(expect.objectContaining({
      role: 'tool', tool_call_id: 'call-read', content: expect.stringContaining('查到 1 条')
    }))
  })

  it('工具调用轮次不向 UI 渲染模型 content，仅最终回答轮展示', async() => {
    readExecute.mockResolvedValueOnce({ ok: true, message: '查到' })
    const llm = new FakeLlm([
      { ...toolReply({ id: 'call-x', name: 'gateway_query_v1', args: '{"keyword":"x"}' }),
        content: '让我先查一下内部推理' },
      finalReply('这是最终答复')
    ])
    const { runtime, emit } = createRuntime(llm)

    await runtime.start('查询线路')

    const assistantContents = emit.mock.calls
      .map(([event]) => event)
      .filter(event => event.type === 'assistant')
      .map(event => event.content)
    expect(assistantContents).toEqual([null, '这是最终答复'])
  })

  it('工具上下文携带本轮用户输入与同一轮页面实况', async() => {
    const pageContext = { rows: [{ id: 7, name: '当前第一行' }] }
    const llm = new FakeLlm([
      toolReply({ id: 'page-reference', name: 'gateway_query_v1', args: '{"keyword":"第一条"}' }),
      finalReply('完成')
    ])
    const { runtime, execute } = createRuntime(llm, {
      getPageContext: async() => pageContext
    })

    await runtime.start('查看第一条详情')

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({
        userInput: '查看第一条详情',
        pageContext
      })
    }))
  })

  it('新 Run 继承上一次完成 Run 的业务模块以支持上下文追问', async() => {
    const resolveCandidates = vi.fn((options: Parameters<
      AgentRuntimeDependencies['resolveCandidates']
    >[0]) => options.text.includes('线路')
      ? ['gateway']
      : options.previousModuleIds ?? [])
    const llm = new FakeLlm([
      finalReply('第一次完成'),
      finalReply('第二次完成'),
      finalReply('清空后完成')
    ])
    const { runtime } = createRuntime(llm, { resolveCandidates })

    await runtime.start('查询线路')
    await runtime.start('最近一周的')

    expect(resolveCandidates.mock.calls[1][0].previousModuleIds).toEqual(['gateway'])
    expect((llm.requests[1].tools as Array<{
      function: { name: string }
    }>).map(tool => tool.function.name)).toContain('gateway_query_v1')

    runtime.clear()
    await runtime.start('新话题')
    expect(resolveCandidates.mock.calls[2][0].previousModuleIds).toEqual([])
    expect(llm.requests[2].tools).toEqual([])
  })

  it('读工具失败后立即以 failed 收敛，不再请求模型自动改参重试', async() => {
    readExecute.mockResolvedValueOnce({ ok: false, message: '时间格式无效' })
    const llm = new FakeLlm([
      toolReply({ id: 'read-fail', name: 'gateway_query_v1', args: '{"keyword":"x"}' }),
      toolReply({ id: 'read-retry', name: 'gateway_query_v1', args: '{"keyword":"y"}' })
    ])
    const { runtime, execute, emit } = createRuntime(llm)

    const result = await runtime.start('查询')

    expect(result.status).toBe('failed')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(llm.requests).toHaveLength(1)
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'tool_result',
      toolCallId: 'read-fail',
      result: { ok: false, message: '时间格式无效' }
    }))
  })

  it('非受控工具异常不进入模型历史或 Runtime UI 事件', async() => {
    const llm = new FakeLlm([
      toolReply({ id: 'unsafe-read', name: 'gateway_query_v1', args: '{"keyword":"x"}' })
    ])
    const { runtime, emit } = createRuntime(llm, {
      actionRouter: {
        execute: vi.fn().mockRejectedValue(new Error('Axios 500 secret-runtime'))
      } as unknown as ActionRouter
    })

    const result = await runtime.start('查询')

    expect(result.status).toBe('failed')
    expect(JSON.stringify(runtime.history)).not.toContain('secret-runtime')
    expect(runtime.history).toContainEqual(expect.objectContaining({
      role: 'tool',
      tool_call_id: 'unsafe-read',
      content: JSON.stringify({ ok: false, message: defaultMessages.executionFailure })
    }))
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'tool_result',
      result: { ok: false, message: defaultMessages.executionFailure }
    }))
    expect(JSON.stringify(emit.mock.calls)).not.toContain('secret-runtime')
  })

  it('受控 ToolPreparationError 保留明确业务校验文案', async() => {
    writePrepare.mockRejectedValueOnce(new ToolPreparationError({
      ok: false,
      message: '缺少必填项：线路IP。'
    }))
    const llm = new FakeLlm([
      toolReply({ id: 'controlled-write', name: 'gateway_update_v1', args: '{"name":"x"}' })
    ])
    const { runtime } = createRuntime(llm)

    await runtime.start('更新线路')

    expect(runtime.history).toContainEqual(expect.objectContaining({
      role: 'tool',
      tool_call_id: 'controlled-write',
      content: JSON.stringify({ ok: false, message: '缺少必填项：线路IP。' })
    }))
  })

  it('同一 assistant reply 的首个工具失败后不执行后续调用', async() => {
    readExecute.mockResolvedValueOnce({ ok: false, message: '查询失败' })
    const llm = new FakeLlm([
      toolReply(
        { id: 'first-fail', name: 'gateway_query_v1', args: '{"keyword":"one"}' },
        { id: 'second-skipped', name: 'gateway_query_v1', args: '{"keyword":"two"}' },
        { id: 'write-skipped', name: 'gateway_update_v1', args: '{"name":"three"}' }
      ),
      finalReply('新 Run 正常')
    ])
    const { runtime, execute, emit } = createRuntime(llm)

    const result = await runtime.start('先查后改')

    expect(result.status).toBe('failed')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(readExecute).toHaveBeenCalledTimes(1)
    expect(writePrepare).not.toHaveBeenCalled()
    expect(runtime.history.filter(message => message.role === 'tool')).toEqual([
      expect.objectContaining({
        tool_call_id: 'first-fail',
        content: JSON.stringify({ ok: false, message: '查询失败' })
      }),
      expect.objectContaining({
        tool_call_id: 'second-skipped',
        content: JSON.stringify({ ok: false, message: defaultMessages.skippedAfterFailure })
      }),
      expect.objectContaining({
        tool_call_id: 'write-skipped',
        content: JSON.stringify({ ok: false, message: defaultMessages.skippedAfterFailure })
      })
    ])
    expect(emit.mock.calls.filter(([event]) => event.type === 'tool_result')).toEqual([
      [expect.objectContaining({ toolCallId: 'first-fail' })]
    ])
    expect(runtime.traces.recent()[0].events.filter(event => event.type === 'tool_failed'))
      .toEqual([expect.objectContaining({ toolCallId: 'first-fail' })])

    await expect(runtime.start('新请求')).resolves.toEqual(expect.objectContaining({
      status: 'completed'
    }))
    expect(llm.requests).toHaveLength(2)
    expect(llm.requests[1].messages.filter(message => message.role === 'tool'))
      .toHaveLength(3)
  })

  it('管理员通配权限可以把具体权限工具发给 LLM', async() => {
    const llm = new FakeLlm([finalReply()])
    const { runtime } = createRuntime(llm, {
      getPermissions: () => ['*:*:*']
    })

    await runtime.start('查询线路')

    expect(llm.requests[0].tools).toContainEqual(expect.objectContaining({
      function: expect.objectContaining({ name: 'gateway_query_v1' })
    }))
  })

  it('确认写工具时重新 prepare，并使用最新且确认内容未变化的 payload', async() => {
    const initialPrepared = {
      title: '确认更新', rows: [{ label: '名称', value: 'safe' }], payload: { id: 7, name: 'safe' }
    }
    const refreshedPrepared = {
      title: '确认更新', rows: [{ label: '名称', value: 'safe' }],
      payload: { id: 7, name: 'safe', latestVersion: 2 }
    }
    writePrepare
      .mockResolvedValueOnce(initialPrepared)
      .mockResolvedValueOnce(refreshedPrepared)
    writeExecute.mockResolvedValueOnce({ ok: true, message: '更新成功' })
    const llm = new FakeLlm([
      toolReply({ id: 'call-write', name: 'gateway_update_v1', args: '{"name":"raw-model-value"}' }),
      finalReply('更新完成')
    ])
    const { runtime, execute } = createRuntime(llm)

    const waiting = await runtime.start('更新线路')
    const confirmation = runtime.currentConfirmation()
    expect(waiting.status).toBe('awaiting_confirmation')
    expect(execute).not.toHaveBeenCalled()
    expect(confirmation).not.toHaveProperty('prepared')

    const completed = await runtime.confirm(confirmation?.confirmationId as string)

    expect(completed.status).toBe('completed')
    expect(completed.runId).toBe(waiting.runId)
    expect(writePrepare).toHaveBeenCalledTimes(2)
    expect(writePrepare.mock.calls[1][1]).toEqual({ name: 'raw-model-value' })
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      prepared: refreshedPrepared,
      input: undefined
    }))
    expect(writeExecute).toHaveBeenCalledWith(expect.anything(), refreshedPrepared.payload)
  })

  it('确认时重新 prepare 的可见内容变化则拒绝执行并要求重新发起', async() => {
    writePrepare.mockReset()
    writeExecute.mockReset()
    writePrepare
      .mockResolvedValueOnce({
        title: '确认更新', rows: [{ label: '线路名称', value: '旧名称' }], payload: { id: 7 }
      })
      .mockResolvedValueOnce({
        title: '确认更新', rows: [{ label: '线路名称', value: '新名称' }], payload: { id: 8 }
      })
    writeExecute.mockResolvedValueOnce({ ok: true, message: '不应执行' })
    const llm = new FakeLlm([
      toolReply({ id: 'stale-write', name: 'gateway_update_v1', args: '{"name":"目标名称"}' })
    ])
    const { runtime, execute, emit } = createRuntime(llm)
    await runtime.start('更新线路')

    const result = await runtime.confirm(runtime.currentConfirmation()?.confirmationId as string)

    expect(result.status).toBe('failed')
    expect(execute).not.toHaveBeenCalled()
    expect(writeExecute).not.toHaveBeenCalled()
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'tool_result',
      toolCallId: 'stale-write',
      result: {
        ok: false,
        message: defaultMessages.confirmationContentChanged
      }
    }))
  })

  it('人工确认等待时间不计入执行超时：确认后写入执行且 Run 正常收敛', async() => {
    let clock = 0
    const prepared = { title: '确认更新', rows: [], payload: { id: 7, name: 'safe' }}
    writePrepare
      .mockResolvedValueOnce(prepared)
      .mockResolvedValueOnce(prepared)
    writeExecute.mockResolvedValueOnce({ ok: true, message: '更新成功' })
    const llm = new FakeLlm([
      toolReply({ id: 'slow-confirm', name: 'gateway_update_v1', args: '{"name":"x"}' }),
      finalReply('更新完成')
    ])
    const { runtime } = createRuntime(llm, {}, { now: () => clock })

    const waiting = await runtime.start('更新线路')
    expect(waiting.status).toBe('awaiting_confirmation')

    // 人工确认耗时超过 Run 超时阈值（60s），这段等待不应计入执行预算
    clock = 60001
    const completed = await runtime.confirm(runtime.currentConfirmation()?.confirmationId as string)

    // 写入按用户确认真实执行
    expect(writeExecute).toHaveBeenCalledTimes(1)
    // 且 Run 不因人工等待被误判为超时失败（否则会诱导用户重复提交）
    expect(completed.status).toBe('completed')
  })

  it('过期确认 ID 被拒绝后，人工等待仍不计入执行超时', async() => {
    let clock = 0
    const prepared = { title: '确认更新', rows: [], payload: { id: 7, name: 'safe' }}
    writePrepare
      .mockResolvedValueOnce(prepared)
      .mockResolvedValueOnce(prepared)
    writeExecute.mockResolvedValueOnce({ ok: true, message: '更新成功' })
    const llm = new FakeLlm([
      toolReply({ id: 'stale-click', name: 'gateway_update_v1', args: '{"name":"x"}' }),
      finalReply('更新完成')
    ])
    const { runtime } = createRuntime(llm, {}, { now: () => clock })

    const waiting = await runtime.start('更新线路')
    expect(waiting.status).toBe('awaiting_confirmation')

    // 上一个 Run 遗留的卡片 / 用户误点，回传了一个不在队首的 ID：必须被拒绝，
    // 且不得就此把「等待确认」的计时关掉。
    await expect(runtime.confirm('stale-id')).rejects.toThrow()

    clock = 60001
    const completed = await runtime.confirm(runtime.currentConfirmation()?.confirmationId as string)

    expect(writeExecute).toHaveBeenCalledTimes(1)
    expect(completed.status).toBe('completed')
  })

  it('过期确认 ID 被拒绝后，取消路径的人工等待同样不计入执行超时', async() => {
    let clock = 0
    writePrepare.mockResolvedValueOnce({ title: '确认', rows: [], payload: { id: 1 }})
    const llm = new FakeLlm([
      toolReply({ id: 'stale-cancel', name: 'gateway_update_v1', args: '{"name":"x"}' }),
      finalReply('已取消')
    ])
    const { runtime } = createRuntime(llm, {}, { now: () => clock })

    await runtime.start('更新线路')
    await expect(runtime.cancel('stale-id')).rejects.toThrow()

    clock = 60001
    const result = await runtime.cancel(runtime.currentConfirmation()?.confirmationId as string)

    expect(result.status).toBe('completed')
  })

  it('确认后重跑 prepare，原始请求变了则拒绝执行', async() => {
    // rawRequest 是卡片上唯一不可能撒谎的部分，用户批准的就是它。
    // 它变了却照旧执行，等于拿着 A 的同意去发 B。
    writePrepare
      .mockResolvedValueOnce({
        title: '确认删除',
        rows: [{ label: '用户', value: '张三' }],
        payload: { id: 'u_1' },
        rawRequest: { method: 'DELETE', url: '/api/users/u_1' }
      })
      .mockResolvedValueOnce({
        title: '确认删除',
        rows: [{ label: '用户', value: '张三' }],
        payload: { id: 'u_9' },
        rawRequest: { method: 'DELETE', url: '/api/users/u_9' }
      })
    const llm = new FakeLlm([
      toolReply({ id: 'call-raw', name: 'gateway_update_v1', args: '{"name":"x"}' }),
      finalReply('已终止')
    ])
    const { runtime, execute } = createRuntime(llm)
    await runtime.start('删除用户')

    const result = await runtime.confirm(
      runtime.currentConfirmation()?.confirmationId as string
    )

    expect(execute).not.toHaveBeenCalled()
    expect(result.status).toBe('failed')
  })

  it('取消写工具时写入真实取消 Tool Result 并恢复模型', async() => {
    writePrepare.mockResolvedValueOnce({ title: '确认', rows: [], payload: { id: 1 }})
    const llm = new FakeLlm([
      toolReply({ id: 'call-cancel', name: 'gateway_update_v1', args: '{"name":"x"}' }),
      finalReply('已取消')
    ])
    const { runtime, execute, emit } = createRuntime(llm)
    await runtime.start('更新线路')

    const result = await runtime.cancel(runtime.currentConfirmation()?.confirmationId as string)

    expect(result.status).toBe('completed')
    expect(execute).not.toHaveBeenCalled()
    expect(llm.requests[1].messages).toContainEqual(expect.objectContaining({
      role: 'tool',
      tool_call_id: 'call-cancel',
      content: JSON.stringify({ ok: false, message: defaultMessages.cancelled, cancelled: true })
    }))
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'tool_result',
      cancelled: true
    }))
  })

  it.each([
    ['success', 'resolve', { ok: true, message: '更新成功' }, { ok: true, message: '更新成功' }],
    ['failed', 'resolve', { ok: false, message: '业务失败' }, {
      ok: false,
      message: defaultMessages.writeStateUnknown,
      writeState: 'unknown'
    }],
    ['aborted', 'reject', undefined, {
      ok: false,
      message: defaultMessages.writeStateUnknown,
      writeState: 'unknown'
    }]
  ] as const)(
    '确认写请求发出后 stop，%s 结果仍通知 UI',
    async(_case, settlement, toolResult, expectedResult) => {
      let finishWrite: ((result: ToolResult) => void) | undefined
      let rejectWrite: ((error: Error) => void) | undefined
      let markStarted: (() => void) | undefined
      const started = new Promise<void>(resolve => { markStarted = resolve })
      writePrepare
        .mockResolvedValueOnce({ title: '确认', rows: [], payload: { id: 1 }})
        .mockResolvedValueOnce({ title: '确认', rows: [], payload: { id: 1 }})
      writeExecute.mockImplementationOnce(() => new Promise<ToolResult>((resolve, reject) => {
        finishWrite = resolve
        rejectWrite = reject
        markStarted?.()
      }))
      const adapters = new PageAdapterRegistry()
      const actionRouter = new ActionRouter({
        adapters,
        navigation: {} as ConstructorParameters<typeof ActionRouter>[0]['navigation'],
        resolveRouteName: () => undefined
      })
      const llm = new FakeLlm([
        toolReply({ id: 'confirmed-stop', name: 'gateway_update_v1', args: '{"name":"x"}' })
      ])
      const { runtime, emit } = createRuntime(llm, { actionRouter })
      await runtime.start('更新')
      const confirming = runtime.confirm(runtime.currentConfirmation()?.confirmationId as string)
      await started

      runtime.stop()
      if (settlement === 'resolve') {
        finishWrite?.(toolResult as ToolResult)
      } else {
        const error = new Error('aborted')
        error.name = 'AbortError'
        rejectWrite?.(error)
      }
      const snapshot = await confirming

      expect(snapshot.status).toBe('cancelled')
      expect(runtime.history).toEqual([])
      expect(emit).toHaveBeenCalledWith(expect.objectContaining({
        type: 'tool_result',
        result: expectedResult
      }))
      expect(emit.mock.calls.filter(([event]) => event.type === 'assistant')).toHaveLength(1)
      expect(writeExecute).toHaveBeenCalledTimes(1)
      expect(llm.requests).toHaveLength(1)
    }
  )

  it('stop 后确认写请求未发出时将结果标记为 cancelled', async() => {
    let finishAction: ((result: ToolResult) => void) | undefined
    let markStarted: (() => void) | undefined
    const started = new Promise<void>(resolve => { markStarted = resolve })
    const actionRouter = {
      execute: vi.fn(() => new Promise<ToolResult>(resolve => {
        finishAction = resolve
        markStarted?.()
      }))
    } as unknown as ActionRouter
    writePrepare
      .mockResolvedValueOnce({ title: '确认', rows: [], payload: { id: 1 }})
      .mockResolvedValueOnce({ title: '确认', rows: [], payload: { id: 1 }})
    const llm = new FakeLlm([
      toolReply({ id: 'cancel-before-write', name: 'gateway_update_v1', args: '{"name":"x"}' })
    ])
    const { runtime, emit } = createRuntime(llm, { actionRouter })
    await runtime.start('更新')
    const confirming = runtime.confirm(runtime.currentConfirmation()?.confirmationId as string)
    await started

    runtime.stop()
    finishAction?.({ ok: false, message: defaultMessages.cancelled, cancelled: true })
    await confirming

    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'tool_result',
      cancelled: true,
      result: { ok: false, message: defaultMessages.cancelled, cancelled: true }
    }))
  })

  it('同一轮多个写调用逐条确认，队列清空后才恢复模型', async() => {
    writePrepare
      .mockResolvedValueOnce({ title: '第一条', rows: [], payload: { id: 1 }})
      .mockResolvedValueOnce({ title: '第二条', rows: [], payload: { id: 2 }})
      .mockResolvedValueOnce({ title: '第一条', rows: [], payload: { id: 1 }})
      .mockResolvedValueOnce({ title: '第二条', rows: [], payload: { id: 2 }})
    writeExecute.mockResolvedValue({ ok: true, message: '成功' })
    const llm = new FakeLlm([
      toolReply(
        { id: 'call-1', name: 'gateway_update_v1', args: '{"name":"one"}' },
        { id: 'call-2', name: 'gateway_update_v1', args: '{"name":"two"}' }
      ),
      finalReply()
    ])
    const { runtime, execute } = createRuntime(llm)
    await runtime.start('批量更新')

    const first = runtime.currentConfirmation()
    const stillWaiting = await runtime.confirm(first?.confirmationId as string)
    expect(stillWaiting.status).toBe('awaiting_confirmation')
    expect(runtime.currentConfirmation()?.toolCallId).toBe('call-2')
    expect(llm.requests).toHaveLength(1)

    const completed = await runtime.confirm(runtime.currentConfirmation()?.confirmationId as string)
    expect(completed.status).toBe('completed')
    expect(execute).toHaveBeenCalledTimes(2)
    expect(llm.requests).toHaveLength(2)
  })

  it('非法 JSON 参数静默回写模型并允许自修正一次', async() => {
    readExecute.mockResolvedValueOnce({ ok: true, message: '查询成功' })
    const llm = new FakeLlm([
      toolReply(
        { id: 'call-json', name: 'gateway_query_v1', args: '{bad-json' },
        { id: 'call-after-json', name: 'gateway_query_v1', args: '{"keyword":"x"}' }
      ),
      toolReply({ id: 'call-corrected', name: 'gateway_query_v1', args: '{"keyword":"x"}' }),
      finalReply('已修正参数并完成查询')
    ])
    const { runtime, execute, emit } = createRuntime(llm)

    expect((await runtime.start('查询')).status).toBe('completed')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(llm.requests).toHaveLength(3)
    expect(llm.requests[1].messages.filter(message => message.role === 'tool')).toEqual([
      expect.objectContaining({
        tool_call_id: 'call-json',
        content: JSON.stringify({ ok: false, message: defaultMessages.invalidJson })
      }),
      expect.objectContaining({
        tool_call_id: 'call-after-json',
        content: JSON.stringify({ ok: false, message: defaultMessages.skippedForModelCorrection })
      })
    ])
    expect(emit.mock.calls
      .map(([event]) => event)
      .filter(event => event.type === 'tool_result' &&
        ['call-json', 'call-after-json'].includes(event.toolCallId as string)))
      .toEqual([])
  })

  it('JSON 与 Schema 参数错误共享一次自修正机会，第二次错误向用户失败', async() => {
    const llm = new FakeLlm([
      toolReply({ id: 'call-schema', name: 'gateway_query_v1', args: '{"keyword":1}' }),
      toolReply({ id: 'call-json-again', name: 'gateway_query_v1', args: '{bad-json' })
    ])
    const { runtime, execute, emit } = createRuntime(llm)

    expect((await runtime.start('查询')).status).toBe('failed')
    expect(execute).not.toHaveBeenCalled()
    expect(llm.requests).toHaveLength(2)
    expect(runtime.history.filter(message => message.role === 'tool')).toEqual([
      expect.objectContaining({
        tool_call_id: 'call-schema',
        content: JSON.stringify({
          ok: false,
          message: defaultMessages.invalidInput
        })
      }),
      expect.objectContaining({
        tool_call_id: 'call-json-again',
        content: JSON.stringify({ ok: false, message: defaultMessages.invalidJson })
      })
    ])
    expect(emit.mock.calls
      .map(([event]) => event)
      .filter(event => event.type === 'tool_result'))
      .toEqual([
        expect.objectContaining({ toolCallId: 'call-json-again' })
      ])
  })

  it('候选首位模块没有已挂载页面时，取下一个真正拿得到上下文的模块', async() => {
    // 候选优先级里「别名精确命中」排在「当前路由」之前，因此排第一的模块经常
    // 并不是用户眼前那个页面。只看 modules[0] 会让页面快照整个丢失。
    const cdrModule = {
      id: 'cdr', title: '话单', description: '话单查询', aliases: ['话单'],
      routes: ['Cdr-list'], permissions: [], prompt: '话单规则', examples: [],
      formatContext: (context: { rows: number }) => `当前页 ${context.rows} 行`
    }
    const captured: Array<unknown> = []
    const { runtime } = createRuntime(new FakeLlm([finalReply('好的')]), {
      resolveCandidates: () => ['gateway', 'cdr'],
      registry: createToolRegistry(
        [gatewayModule, cdrModule],
        [createTools().readTool]
      ),
      // gateway 页面没挂载，cdr 页面挂载着
      getPageContext: async(moduleId: string) =>
        moduleId === 'cdr' ? { rows: 12 } : null,
      composePrompt: async({ pageContext, history }) => {
        captured.push(pageContext)
        return history as LlmMessage[]
      }
    })

    await runtime.start('这通电话是谁打的')

    expect(captured[0]).toEqual({ moduleId: 'cdr', value: { rows: 12 }})
  })

  it('候选模块都没有已挂载页面时不注入页面上下文', async() => {
    const captured: Array<unknown> = []
    const { runtime } = createRuntime(new FakeLlm([finalReply('好的')]), {
      getPageContext: async() => null,
      composePrompt: async({ pageContext, history }) => {
        captured.push(pageContext)
        return history as LlmMessage[]
      }
    })

    await runtime.start('查询线路')

    expect(captured[0]).toBeUndefined()
  })

  it('模型把工具调用写进 content 时按工具调用执行（小模型兼容）', async() => {
    readExecute.mockResolvedValue({ ok: true, message: '命中 2 条' })
    const llm = new FakeLlm([
      // 不少小参数量模型不稳定填 tool_calls，而是把调用直接吐在文本里。
      {
        role: 'assistant',
        content: '{"name":"gateway_query_v1","arguments":{"keyword":"x"}}'
      },
      finalReply('共 2 条')
    ])
    const { runtime, execute } = createRuntime(llm)

    const result = await runtime.start('查询线路')

    expect(execute).toHaveBeenCalledTimes(1)
    expect(result.status).toBe('completed')
  })

  it('content 里的普通 JSON 回复不被误判成工具调用', async() => {
    const llm = new FakeLlm([
      { role: 'assistant', content: '{"summary":"共 2 条","page":1}' }
    ])
    const { runtime, execute } = createRuntime(llm)

    const result = await runtime.start('查询线路')

    expect(execute).not.toHaveBeenCalled()
    expect(result.status).toBe('completed')
  })

  it('content 里指向未暴露工具的 JSON 不被当作工具调用（防绕过权限过滤）', async() => {
    const llm = new FakeLlm([
      { role: 'assistant', content: '{"name":"admin_drop_db_v1","arguments":{}}' }
    ])
    const { runtime, execute } = createRuntime(llm)

    const result = await runtime.start('查询线路')

    expect(execute).not.toHaveBeenCalled()
    expect(result.status).toBe('completed')
  })

  it('最多请求模型 6 轮', async() => {
    readExecute.mockResolvedValue({ ok: true, message: 'ok' })
    const replies = Array.from({ length: 6 }, (_, index) => toolReply({
      id: 'round-' + index,
      name: 'gateway_query_v1',
      args: '{"keyword":"x"}'
    }))
    const llm = new FakeLlm(replies)
    const { runtime } = createRuntime(llm)

    const result = await runtime.start('循环查询')

    expect(result.status).toBe('failed')
    expect(llm.requests).toHaveLength(6)
    // maxRounds 命中时上一轮工具已补齐结果，不得对已完成的 tool_call_id 重复追加，
    // 否则同一 tool_call_id 会出现两条 tool 消息（协议非法）。
    const toolCallIds = runtime.history
      .filter(message => message.role === 'tool')
      .map(message => (message as { tool_call_id: string }).tool_call_id)
    expect(toolCallIds).toEqual([...new Set(toolCallIds)])
    expect(toolCallIds.filter(id => id === 'round-5')).toHaveLength(1)
  })

  it('每个 Run 最多处理 12 个工具调用', async() => {
    readExecute.mockResolvedValue({ ok: true, message: 'ok' })
    const calls = Array.from({ length: 13 }, (_, index) => ({
      id: 'call-' + index, name: 'gateway_query_v1', args: '{"keyword":"x"}'
    }))
    const { runtime, execute } = createRuntime(new FakeLlm([toolReply(...calls)]))

    const result = await runtime.start('执行很多工具')

    expect(result.status).toBe('failed')
    expect(execute).toHaveBeenCalledTimes(12)
    expect(runtime.history.at(-1)).toEqual(expect.objectContaining({
      role: 'tool', tool_call_id: 'call-12', content: expect.stringContaining(formatMessage(defaultMessages.maxToolCallsReached, { limit: 12 }))
    }))
  })

  it('Run 超过 60 秒后确定性停止', async() => {
    let clockReads = 0
    const llm = new FakeLlm([finalReply()])
    const { runtime } = createRuntime(llm, {}, {
      now: () => clockReads++ === 0 ? 0 : 60001
    })

    const result = await runtime.start('超时请求')

    expect(result.status).toBe('failed')
    expect(llm.requests).toHaveLength(0)
    expect(runtime.traces.recent()[0].stopReason).toBe(formatMessage(defaultMessages.runTimeout, { ms: 60000 }))
  })

  it('在途 LLM 请求超时时标记失败而不是用户取消', async() => {
    const neverReplies: LlmClient = {
      chat: (_messages, _tools, signal) => new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        })
      })
    }
    const { runtime } = createRuntime(neverReplies, {}, { runTimeoutMs: 5 })

    const result = await runtime.start('等待超时')

    expect(result.status).toBe('failed')
    expect(runtime.traces.recent()[0].stopReason).toBe(formatMessage(defaultMessages.runTimeout, { ms: 5 }))
  })

  it('重复 Tool Call 只执行一次并返回确定性失败', async() => {
    readExecute.mockResolvedValue({ ok: true, message: 'ok' })
    const duplicate = { id: 'same-call', name: 'gateway_query_v1', args: '{"keyword":"x"}' }
    const llm = new FakeLlm([toolReply(duplicate, duplicate), finalReply()])
    const { runtime, execute } = createRuntime(llm)

    expect((await runtime.start('重复调用')).status).toBe('failed')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(llm.requests).toHaveLength(1)
    expect(runtime.history).toContainEqual(expect.objectContaining({
      role: 'tool', tool_call_id: 'same-call', content: expect.stringContaining(defaultMessages.duplicateToolCall)
    }))
  })

  it('模型调用未暴露工具时软失败并让其在下一轮自我纠正', async() => {
    readExecute.mockResolvedValue({ ok: true, message: '查询成功' })
    const llm = new FakeLlm([
      toolReply({ id: 'call-bad', name: 'gateway_ghost_v9', args: '{}' }),
      toolReply({ id: 'call-good', name: 'gateway_query_v1', args: '{"keyword":"x"}' }),
      finalReply('已改用正确工具')
    ])
    const { runtime, execute } = createRuntime(llm)

    const result = await runtime.start('在列表里展示')

    // 未暴露工具不再直接终止 Run，模型得以重试并正常收敛
    expect(result.status).toBe('completed')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(llm.requests.length).toBeGreaterThanOrEqual(2)
    // 软失败结果写回历史，且提示当前可用工具，引导模型改用
    expect(runtime.history).toContainEqual(expect.objectContaining({
      role: 'tool',
      tool_call_id: 'call-bad',
      content: expect.stringContaining('gateway_query_v1')
    }))
  })

  it('已提交写工具失败后保留真实结果并停止确认队列', async() => {
    writePrepare
      .mockResolvedValueOnce({ title: '第一条', rows: [], payload: { id: 1 }})
      .mockResolvedValueOnce({ title: '第二条', rows: [], payload: { id: 2 }})
      .mockResolvedValueOnce({ title: '第一条', rows: [], payload: { id: 1 }})
    const committedFailure: ToolResult = {
      ok: false,
      message: '写入成功，但页面刷新失败，请勿重复提交',
      writeState: 'committed'
    }
    writeExecute.mockResolvedValueOnce(committedFailure)
    const llm = new FakeLlm([
      toolReply(
        { id: 'write-fail', name: 'gateway_update_v1', args: '{"name":"x"}' },
        { id: 'write-skipped', name: 'gateway_update_v1', args: '{"name":"y"}' }
      ),
      finalReply('不应请求')
    ])
    const { runtime, execute, emit } = createRuntime(llm)
    await runtime.start('更新')

    const result = await runtime.confirm(runtime.currentConfirmation()?.confirmationId as string)

    expect(result.status).toBe('failed')
    expect(runtime.currentConfirmation()).toBeUndefined()
    expect(execute).toHaveBeenCalledTimes(1)
    expect(writeExecute).toHaveBeenCalledTimes(1)
    expect(llm.requests).toHaveLength(1)
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'tool_result',
      toolCallId: 'write-fail',
      result: committedFailure
    }))
    expect(runtime.history.filter(message => message.role === 'tool')).toEqual([
      expect.objectContaining({
        tool_call_id: 'write-fail',
        content: JSON.stringify(committedFailure)
      }),
      expect.objectContaining({
        tool_call_id: 'write-skipped',
        content: JSON.stringify({ ok: false, message: defaultMessages.skippedAfterFailure })
      })
    ])
    expect(emit.mock.calls.filter(([event]) => event.type === 'tool_result')).toEqual([
      [expect.objectContaining({ toolCallId: 'write-fail' })]
    ])

    expect((await runtime.start('新请求')).status).toBe('completed')
    expect(llm.requests).toHaveLength(2)
  })

  it('写结果未知时补齐协议历史并停止确认队列', async() => {
    writePrepare
      .mockResolvedValueOnce({ title: '第一条', rows: [], payload: { id: 1 }})
      .mockResolvedValueOnce({ title: '第二条', rows: [], payload: { id: 2 }})
      .mockResolvedValueOnce({ title: '第一条', rows: [], payload: { id: 1 }})
    const unknownFailure: ToolResult = {
      ok: false,
      message: defaultMessages.writeStateUnknown,
      writeState: 'unknown'
    }
    writeExecute.mockResolvedValueOnce(unknownFailure)
    const llm = new FakeLlm([
      toolReply(
        { id: 'write-unknown', name: 'gateway_update_v1', args: '{"name":"x"}' },
        { id: 'write-after-unknown', name: 'gateway_update_v1', args: '{"name":"y"}' }
      ),
      finalReply('新 Run 正常')
    ])
    const { runtime, execute, emit } = createRuntime(llm)
    await runtime.start('更新')

    const result = await runtime.confirm(runtime.currentConfirmation()?.confirmationId as string)

    expect(result.status).toBe('failed')
    expect(runtime.currentConfirmation()).toBeUndefined()
    expect(execute).toHaveBeenCalledTimes(1)
    expect(runtime.history.filter(message => message.role === 'tool')).toEqual([
      expect.objectContaining({
        tool_call_id: 'write-unknown',
        content: JSON.stringify(unknownFailure)
      }),
      expect.objectContaining({
        tool_call_id: 'write-after-unknown',
        content: JSON.stringify({ ok: false, message: defaultMessages.skippedAfterFailure })
      })
    ])
    expect(emit.mock.calls.filter(([event]) => event.type === 'tool_result')).toEqual([
      [expect.objectContaining({ toolCallId: 'write-unknown', result: unknownFailure })]
    ])

    expect((await runtime.start('新请求')).status).toBe('completed')
    expect(llm.requests).toHaveLength(2)
  })

  it('stop 中止在途 LLM 请求并回滚到 historySafePoint', async() => {
    let markRequestStarted: (() => void) | undefined
    const requestStarted = new Promise<void>(resolve => { markRequestStarted = resolve })
    const waitingLlm: LlmClient = {
      chat: (_messages, _tools, signal) => new Promise((_resolve, reject) => {
        markRequestStarted?.()
        signal?.addEventListener('abort', () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        })
      })
    }
    const { runtime } = createRuntime(waitingLlm)
    const before = runtime.history
    const running = runtime.start('需要中止')
    await requestStarted

    runtime.stop()
    const result = await running

    expect(result.status).toBe('cancelled')
    expect(runtime.history).toEqual(before)
    expect(runtime.traces.recent()[0].stopReason).toBe(defaultMessages.stoppedByUser)
  })

  it('等待确认时拒绝启动冲突 Run', async() => {
    writePrepare.mockResolvedValueOnce({ title: '确认', rows: [], payload: { id: 1 }})
    const { runtime } = createRuntime(new FakeLlm([
      toolReply({ id: 'pending', name: 'gateway_update_v1', args: '{"name":"x"}' })
    ]))
    await runtime.start('更新')

    await expect(runtime.start('新请求')).rejects.toThrow('当前 Run 正在等待确认')
  })

  it.each([
    ['completed', new FakeLlm([finalReply()])],
    ['failed', new FakeLlm([])]
  ])('%s 后 clear 清空会话并回到 idle', async(_status, llm) => {
    const { runtime, emit } = createRuntime(llm, {}, { maxRounds: _status === 'failed' ? 0 : 6 })
    await runtime.start('需要清空')

    runtime.clear()

    expect(runtime.history).toEqual([])
    expect(runtime.currentConfirmation()).toBeUndefined()
    expect(runtime.snapshot()).toEqual({ runId: '', traceId: '', status: 'idle' })
    expect(emit).toHaveBeenLastCalledWith({
      type: 'clear',
      snapshot: { runId: '', traceId: '', status: 'idle' },
      activeModuleIds: []
    })
  })

  it('cancelled 后 clear 清空状态，且可启动新 Run', async() => {
    let markRequestStarted: (() => void) | undefined
    const requestStarted = new Promise<void>(resolve => { markRequestStarted = resolve })
    let firstRequest = true
    const llm: LlmClient = {
      chat: (_messages, _tools, signal) => {
        if (firstRequest) {
          firstRequest = false
          return new Promise((_resolve, reject) => {
            markRequestStarted?.()
            signal?.addEventListener('abort', () => {
              const error = new Error('aborted')
              error.name = 'AbortError'
              reject(error)
            })
          })
        }
        return Promise.resolve(finalReply('第二次'))
      }
    }
    const { runtime } = createRuntime(llm)
    const firstRun = runtime.start('第一次')
    await requestStarted
    runtime.stop()
    expect((await firstRun).status).toBe('cancelled')

    runtime.clear()
    const second = await runtime.start('第二次')

    expect(second.status).toBe('completed')
    expect(runtime.history).toEqual([
      { role: 'user', content: '第二次' },
      { role: 'assistant', content: '第二次' }
    ])
  })

  it('执行中或等待确认时拒绝 clear，stop 后可 clear', async() => {
    let markRequestStarted: (() => void) | undefined
    const requestStarted = new Promise<void>(resolve => { markRequestStarted = resolve })
    const waitingLlm: LlmClient = {
      chat: (_messages, _tools, signal) => new Promise((_resolve, reject) => {
        markRequestStarted?.()
        signal?.addEventListener('abort', () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        })
      })
    }
    const { runtime } = createRuntime(waitingLlm)
    const running = runtime.start('执行中')
    await requestStarted

    expect(() => runtime.clear()).toThrow('当前 Run 尚未结束，请先停止或处理确认')
    runtime.stop()
    await running
    expect(() => runtime.clear()).not.toThrow()

    writePrepare.mockResolvedValueOnce({ title: '确认', rows: [], payload: { id: 1 }})
    const awaiting = createRuntime(new FakeLlm([
      toolReply({ id: 'pending-clear', name: 'gateway_update_v1', args: '{"name":"x"}' })
    ])).runtime
    await awaiting.start('等待确认')
    expect(() => awaiting.clear()).toThrow('当前 Run 尚未结束，请先停止或处理确认')
  })

  it('state 事件携带当前模块副本，不暴露 Runtime 内部数组', async() => {
    const candidates = ['gateway']
    const { runtime, emit } = createRuntime(new FakeLlm([finalReply()]), {
      resolveCandidates: () => candidates
    })

    await runtime.start('查询')
    const stateEvent = emit.mock.calls
      .map(([event]) => event)
      .find(event => event.type === 'state' && event.activeModuleIds?.length)
    expect(stateEvent?.activeModuleIds).toEqual(['gateway'])

    stateEvent?.activeModuleIds?.push('mutated')
    expect(emit.mock.calls.at(-1)?.[0].activeModuleIds).toEqual(['gateway'])
  })

  it('stop 后立即 clear 会屏蔽不响应 signal 的旧工具回调', async() => {
    let resolveTool: ((result: ToolResult) => void) | undefined
    const toolStarted = new Promise<void>(resolve => {
      readExecute.mockImplementationOnce(() => new Promise<ToolResult>(toolResolve => {
        resolveTool = toolResolve
        resolve()
      }))
    })
    const { runtime, emit } = createRuntime(new FakeLlm([
      toolReply({ id: 'slow-tool', name: 'gateway_query_v1', args: '{"keyword":"x"}' }),
      finalReply()
    ]))
    const running = runtime.start('慢工具')
    await toolStarted

    runtime.stop()
    runtime.clear()
    const eventCountAfterClear = emit.mock.calls.length
    resolveTool?.({ ok: true, message: '过期结果' })
    await running

    expect(runtime.snapshot()).toEqual({ runId: '', traceId: '', status: 'idle' })
    expect(runtime.history).toEqual([])
    expect(emit.mock.calls).toHaveLength(eventCountAfterClear)
    expect(emit).toHaveBeenLastCalledWith({
      type: 'clear',
      snapshot: { runId: '', traceId: '', status: 'idle' },
      activeModuleIds: []
    })
  })

  it('旧 LLM 延迟超时不会清空新 Run 的确认队列', async() => {
    let firstRequestStarted: (() => void) | undefined
    const requestStarted = new Promise<void>(resolve => { firstRequestStarted = resolve })
    let requestCount = 0
    const llm: LlmClient = {
      chat: () => {
        requestCount += 1
        if (requestCount === 1) {
          firstRequestStarted?.()
          return new Promise(() => undefined)
        }
        return Promise.resolve(toolReply({
          id: 'new-confirmation',
          name: 'gateway_update_v1',
          args: '{"name":"new-run"}'
        }))
      }
    }
    writePrepare.mockResolvedValueOnce({ title: '新 Run 确认', rows: [], payload: { id: 2 }})
    const { runtime } = createRuntime(llm, {}, { runTimeoutMs: 15 })
    const oldRun = runtime.start('旧 Run')
    await requestStarted
    runtime.stop()
    runtime.clear()

    const newRun = await runtime.start('新 Run')
    expect(newRun.status).toBe('awaiting_confirmation')
    const confirmationId = runtime.currentConfirmation()?.confirmationId
    await oldRun

    expect(runtime.snapshot()).toEqual(newRun)
    expect(runtime.currentConfirmation()?.confirmationId).toBe(confirmationId)
  })

  it('同一 reply 的首个慢工具期间 stop，不再 prepare 后续调用', async() => {
    let resolveFirst: ((result: ToolResult) => void) | undefined
    const firstStarted = new Promise<void>(resolve => {
      readExecute.mockImplementationOnce(() => new Promise<ToolResult>(toolResolve => {
        resolveFirst = toolResolve
        resolve()
      }))
    })
    writePrepare.mockResolvedValueOnce({ title: '不应出现', rows: [], payload: { id: 9 }})
    const { runtime, emit } = createRuntime(new FakeLlm([
      toolReply(
        { id: 'slow-first', name: 'gateway_query_v1', args: '{"keyword":"x"}' },
        { id: 'write-second', name: 'gateway_update_v1', args: '{"name":"y"}' },
        { id: 'read-third', name: 'gateway_query_v1', args: '{"keyword":"z"}' }
      )
    ]))
    const running = runtime.start('先查后改')
    await firstStarted

    runtime.stop()
    const eventCountAfterStop = emit.mock.calls.length
    resolveFirst?.({ ok: true, message: '过期查询' })
    const result = await running

    expect(result.status).toBe('cancelled')
    expect(runtime.snapshot().status).toBe('cancelled')
    expect(writePrepare).not.toHaveBeenCalled()
    expect(readExecute).toHaveBeenCalledTimes(1)
    expect(emit.mock.calls).toHaveLength(eventCountAfterStop)
    expect(emit.mock.calls.at(-1)?.[0].snapshot?.status).toBe('cancelled')
  })

  it('首个慢工具期间 clear，旧 Run 不再执行后续工具', async() => {
    let resolveFirst: ((result: ToolResult) => void) | undefined
    const firstStarted = new Promise<void>(resolve => {
      readExecute.mockImplementationOnce(() => new Promise<ToolResult>(toolResolve => {
        resolveFirst = toolResolve
        resolve()
      }))
    })
    readExecute.mockResolvedValueOnce({ ok: true, message: '第二个不应执行' })
    const { runtime } = createRuntime(new FakeLlm([
      toolReply(
        { id: 'clear-first', name: 'gateway_query_v1', args: '{"keyword":"one"}' },
        { id: 'clear-second', name: 'gateway_query_v1', args: '{"keyword":"two"}' }
      )
    ]))
    const running = runtime.start('清空慢工具')
    await firstStarted

    runtime.stop()
    runtime.clear()
    resolveFirst?.({ ok: true, message: '过期查询' })
    await running

    expect(readExecute).toHaveBeenCalledTimes(1)
    expect(runtime.snapshot().status).toBe('idle')
  })
})

describe('缺少信息不是失败，而是让对话继续', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  // 「少填了几个字段」和「操作真的出错了」是两回事。前者只要追问一句就能继续，
  // 把它判成 Run 失败，用户看到的是一句「处理失败，请稍后重试」——既不准确，
  // 也把本可以两轮完成的事变成了死胡同。
  it('prepare 报缺信息时，Run 继续，模型得以向用户追问', async() => {
    writePrepare.mockRejectedValueOnce(new ToolPreparationError({
      ok: false,
      message: '缺少必填项：计费类型、并发量。',
      needsUserInput: true
    }))
    const llm = new FakeLlm([
      toolReply({ id: 'call-1', name: 'gateway_update_v1', args: '{"name":"CPV2"}' }),
      finalReply('还需要你补充计费类型和并发量。')
    ])
    const { runtime, emit } = createRuntime(llm)

    const snapshot = await runtime.start('新增一条线路')

    expect(snapshot.status).toBe('completed')
    const assistant = emit.mock.calls
      .map(([e]) => e).filter(e => e.type === 'assistant' && e.content)
    expect(assistant.at(-1)?.content).toBe('还需要你补充计费类型和并发量。')
  })

  it('缺信息的结果照常回喂给模型，模型才知道缺什么', async() => {
    writePrepare.mockRejectedValueOnce(new ToolPreparationError({
      ok: false,
      message: '缺少必填项：计费类型。',
      needsUserInput: true
    }))
    const llm = new FakeLlm([
      toolReply({ id: 'call-1', name: 'gateway_update_v1', args: '{"name":"CPV2"}' }),
      finalReply('请补充计费类型。')
    ])
    const { runtime } = createRuntime(llm)

    await runtime.start('新增线路')

    const toolMessage = runtime.history.find(m => m.role === 'tool')
    expect(toolMessage).toBeDefined()
    expect(toolMessage?.content).toContain('缺少必填项：计费类型。')
  })

  it('读工具同样适用：查询需要澄清时不终止 Run', async() => {
    readExecute.mockResolvedValueOnce({
      ok: false,
      message: '同名线路有多条，请补充公司 ID。',
      needsUserInput: true
    })
    const llm = new FakeLlm([
      toolReply({ id: 'call-1', name: 'gateway_query_v1', args: '{"keyword":"测试"}' }),
      finalReply('有多条同名线路，请告诉我公司 ID。')
    ])
    const { runtime } = createRuntime(llm)

    const snapshot = await runtime.start('查一下测试线路')

    expect(snapshot.status).toBe('completed')
  })

  it('未标记的失败仍然快速终止，不给模型自行改参重试的机会', async() => {
    // 这条守住原有语义：真正的失败不该退化成「再试一次」的循环。
    writePrepare.mockRejectedValueOnce(new ToolPreparationError({
      ok: false,
      message: '目标线路不存在。'
    }))
    const llm = new FakeLlm([
      toolReply({ id: 'call-1', name: 'gateway_update_v1', args: '{"name":"CPV2"}' }),
      finalReply('不该走到这里')
    ])
    const { runtime } = createRuntime(llm)

    const snapshot = await runtime.start('更新线路')

    expect(snapshot.status).toBe('failed')
  })
})

describe('说了「要用户补信息」之后，模型不能自己编', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  // 实测发现：仅让 Run 继续，模型会把缺失字段（单价、并发量这类只有用户知道的东西）
  // 凭空编出来，而不是开口问。提示词里写了「不得猜测补全」，它照样编。
  // 于是从机制上断掉这条路：这一轮干脆不给工具，它只能说话。
  it('紧接着的一轮不暴露任何工具，模型只能开口问', async() => {
    writePrepare.mockRejectedValueOnce(new ToolPreparationError({
      ok: false,
      message: '缺少必填项：单价、并发量。',
      needsUserInput: true
    }))
    const llm = new FakeLlm([
      toolReply({ id: 'call-1', name: 'gateway_update_v1', args: '{"name":"CPV2"}' }),
      finalReply('还需要单价和并发量，请告诉我。')
    ])
    const { runtime } = createRuntime(llm)

    await runtime.start('新增线路')

    expect(llm.requests).toHaveLength(2)
    expect(llm.requests[0].tools.length).toBeGreaterThan(0)
    expect(llm.requests[1].tools).toEqual([])
  })

  it('用户答复后重新开的 Run 恢复全部工具', async() => {
    writePrepare.mockRejectedValueOnce(new ToolPreparationError({
      ok: false,
      message: '缺少必填项：单价。',
      needsUserInput: true
    }))
    const first = new FakeLlm([
      toolReply({ id: 'call-1', name: 'gateway_update_v1', args: '{"name":"CPV2"}' }),
      finalReply('请给单价。')
    ])
    const { runtime } = createRuntime(first)
    await runtime.start('新增线路')

    const second = new FakeLlm([finalReply('好的')])
    const { runtime: runtime2 } = createRuntime(second)
    await runtime2.start('单价 0.05')

    expect(second.requests[0].tools.length).toBeGreaterThan(0)
  })

  it('普通工具失败不触发禁用，正常的多工具编排不受影响', async() => {
    readExecute.mockResolvedValueOnce({ ok: true, message: '查到 3 条' })
    const llm = new FakeLlm([
      toolReply({ id: 'call-1', name: 'gateway_query_v1', args: '{"keyword":"CPV2"}' }),
      finalReply('查到 3 条。')
    ])
    const { runtime } = createRuntime(llm)

    await runtime.start('查线路')

    expect(llm.requests[1].tools.length).toBeGreaterThan(0)
  })
})

describe('模块与工具上限可由宿主调整', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('缺省时按内置预算收窄', async() => {
    const llm = new FakeLlm([finalReply()])
    const { runtime } = createRuntime(llm, {
      resolveCandidates: () => ['gateway', 'cdr', 'customer', 'task']
    })

    await runtime.start('随便问')

    const trace = runtime.traces.recent().at(-1)
    const candidates = trace?.events.find(e => e.type === 'candidates')?.names
    expect(candidates).toHaveLength(2)
  })

  it('宿主放开后，一轮内可暴露更多模块——即「全局接入」', async() => {
    const llm = new FakeLlm([finalReply()])
    const { runtime } = createRuntime(llm, {
      resolveCandidates: () => ['gateway', 'cdr', 'customer', 'task']
    }, { maxCandidateModules: 10 })

    await runtime.start('随便问')

    const trace = runtime.traces.recent().at(-1)
    const candidates = trace?.events.find(e => e.type === 'candidates')?.names
    expect(candidates).toEqual(['gateway', 'cdr', 'customer', 'task'])
  })

  it('工具上限同样可调，避免模块放开后被工具预算二次截断', async() => {
    const llm = new FakeLlm([finalReply()])
    const { runtime } = createRuntime(llm, {}, { maxExposedTools: 1 })

    await runtime.start('随便问')

    expect(llm.requests[0].tools).toHaveLength(1)
  })
})
