/**
 * 把拦截判定写入核心的审计轨迹。
 *
 * 治理的三件事——拦住、问人、**留痕**——前两件已经做了，这一件补齐闭环：事后要能
 * 回答「这次写入是谁发起的、走的哪条规则、人批了没有」。
 */
import { describe, expect, it, vi } from 'vitest'
import { createTraceRecorder } from './trace'
import type { InterceptedRequest } from './types'

function request(overrides: Partial<InterceptedRequest> = {}): InterceptedRequest {
  return {
    id: 'req-1',
    method: 'DELETE',
    url: 'https://app.test/api/customers/c_1?token=secret',
    headers: {},
    channel: 'fetch',
    timestamp: 0,
    ...overrides
  }
}

/** 最小的 TraceCollector 形状，与核心包结构兼容。 */
function createCollector() {
  const events: Array<{ runId: string, event: Record<string, unknown> }> = []
  return {
    events,
    record: vi.fn((runId: string, event: Record<string, unknown>) => {
      events.push({ runId, event })
    })
  }
}

describe('判定写入轨迹', () => {
  it('放行也记录——审计要能证明「这次没拦」是有依据的', () => {
    const traces = createCollector()
    const record = createTraceRecorder({ traces, getRunId: () => 'run-1' })

    record(request({ method: 'GET' }), { action: 'allow' })

    expect(traces.events[0]).toMatchObject({
      runId: 'run-1',
      event: { type: 'request_allowed', functionName: 'GET /api/customers/c_1' }
    })
  })

  it('需要确认的请求按风险等级分型', () => {
    const traces = createCollector()
    const record = createTraceRecorder({ traces, getRunId: () => 'run-1' })

    record(request(), { action: 'confirm', risk: 'destructive', ruleId: 'del-customer' })

    expect(traces.events[0].event).toMatchObject({
      type: 'request_confirm_required',
      effectType: 'destructive',
      names: ['del-customer']
    })
  })

  it('拒绝单独成型，便于统计闸门实际挡下了多少', () => {
    const traces = createCollector()
    const record = createTraceRecorder({ traces, getRunId: () => 'run-1' })

    record(request(), { action: 'deny', reason: '默认拒绝' })

    expect(traces.events[0].event).toMatchObject({ type: 'request_denied' })
  })
})

describe('URL 脱敏', () => {
  it('query 一律剥掉——它常带 token 与个人信息，而轨迹会落到本地存储', () => {
    // 核心的 TraceCollector 连用户原话都只存长度，判定轨迹不该反而更宽松。
    const traces = createCollector()
    const record = createTraceRecorder({ traces, getRunId: () => 'run-1' })

    record(request({ url: 'https://app.test/api/users?token=abc&phone=13800138000' }),
      { action: 'allow' })

    const name = traces.events[0].event.functionName as string
    expect(name).not.toContain('token')
    expect(name).not.toContain('13800138000')
    expect(name).toBe('DELETE /api/users')
  })

  it('只留 path，不留 origin——同源信息对审计无用且更长', () => {
    const traces = createCollector()
    const record = createTraceRecorder({ traces, getRunId: () => 'run-1' })

    record(request({ url: 'https://app.test/api/customers/c_1' }), { action: 'allow' })

    expect(traces.events[0].event.functionName).toBe('DELETE /api/customers/c_1')
  })

  it('相对 URL 与畸形 URL 不致崩溃', () => {
    const traces = createCollector()
    const record = createTraceRecorder({ traces, getRunId: () => 'run-1' })

    record(request({ url: '/api/x?a=1' }), { action: 'allow' })
    record(request({ url: '::::' }), { action: 'allow' })

    expect(traces.events).toHaveLength(2)
    expect(traces.events[0].event.functionName).toBe('DELETE /api/x')
  })

  it('请求体不进轨迹——它是最容易带敏感数据的部分', () => {
    const traces = createCollector()
    const record = createTraceRecorder({ traces, getRunId: () => 'run-1' })

    record(request({ body: { password: 'admin123', idCard: '110101' } }), { action: 'allow' })

    expect(JSON.stringify(traces.events[0])).not.toContain('admin123')
    expect(JSON.stringify(traces.events[0])).not.toContain('110101')
  })
})

describe('没有活跃 Run 时', () => {
  it('拿不到 runId 就跳过，不抛错', () => {
    // 拦截器可以在没有 Agent 运行时的页面上单独使用，那时根本没有 Run 可归属。
    const traces = createCollector()
    const record = createTraceRecorder({ traces, getRunId: () => undefined })

    expect(() => record(request(), { action: 'allow' })).not.toThrow()
    expect(traces.record).not.toHaveBeenCalled()
  })

  it('写入失败不影响请求本身——记不了日志不该把功能弄挂', () => {
    const traces = {
      record: vi.fn(() => { throw new Error('存储配额已满') })
    }
    const record = createTraceRecorder({ traces, getRunId: () => 'run-1' })

    expect(() => record(request(), { action: 'allow' })).not.toThrow()
  })
})

describe('接到拦截器上', () => {
  it('onVerdict 直接就是它的签名', async () => {
    const { createInterceptor } = await import('./interceptor')
    const { createStaticAttribution } = await import('./attribution')
    const traces = createCollector()
    const originalFetch = window.fetch
    window.fetch = vi.fn(async () => new Response('{}')) as typeof fetch

    const interceptor = createInterceptor({
      policy: {},
      attribution: createStaticAttribution(true),
      confirm: async () => true,
      onVerdict: createTraceRecorder({ traces, getRunId: () => 'run-1' })
    })
    const uninstall = interceptor.install()

    await fetch('/api/users/u_1', { method: 'DELETE' })

    uninstall()
    window.fetch = originalFetch

    expect(traces.events[0].event).toMatchObject({
      type: 'request_confirm_required',
      functionName: 'DELETE /api/users/u_1'
    })
  })
})
