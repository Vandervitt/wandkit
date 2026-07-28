import { describe, expect, it } from 'vitest'
import { TraceCollector } from './traceCollector'
import {
  DEFAULT_TRACE_GLOBAL_KEY,
  installTraceDiagnostics
} from './traceDiagnostics'

describe('Trace Diagnostics', () => {
  it('提供运行结果和工具成功率摘要', () => {
    const traces = new TraceCollector()
    traces.start('run-1', 'trace-1', '敏感用户输入')
    traces.record('run-1', { type: 'tool_succeeded', functionName: 'cdr_query_v1' })
    traces.finish('run-1', 'completed')
    traces.start('run-2', 'trace-2', '另一条输入')
    traces.record('run-2', { type: 'tool_failed', functionName: 'gateway_query_v1' })
    traces.finish('run-2', 'failed', '执行失败')
    const target: Record<string, unknown> = {}

    installTraceDiagnostics(target, traces, true)

    expect((target.__TOOLAIRLOCK_TRACE__ as any).summary()).toEqual({
      runs: 2,
      completed: 1,
      failed: 1,
      cancelled: 0,
      toolSucceeded: 1,
      toolFailed: 1,
      toolSuccessRate: 0.5
    })
  })

  it('导出内容只来自已脱敏 Trace，生产环境不安装入口', () => {
    const traces = new TraceCollector()
    traces.start('run-safe', 'trace-safe', 'phone=13800138000 token=secret')
    traces.finish('run-safe', 'completed')
    const target: Record<string, unknown> = {}

    installTraceDiagnostics(target, traces, true)
    const exported = (target.__TOOLAIRLOCK_TRACE__ as any).exportJson()
    expect(exported).toContain('[redacted:length=')
    expect(exported).not.toContain('13800138000')
    expect(exported).not.toContain('secret')

    const productionTarget: Record<string, unknown> = {}
    installTraceDiagnostics(productionTarget, traces, false)
    expect(productionTarget).not.toHaveProperty('__TOOLAIRLOCK_TRACE__')
  })
})

describe('全局挂载名可覆盖', () => {
  it('宿主可指定属性名，保住既有的控制台调试习惯', () => {
    const target: Record<string, unknown> = {}
    installTraceDiagnostics(target, new TraceCollector(10, undefined), true, '__MY_TRACE__')

    expect(target.__MY_TRACE__).toBeDefined()
    expect(target[DEFAULT_TRACE_GLOBAL_KEY]).toBeUndefined()
    expect(DEFAULT_TRACE_GLOBAL_KEY).toBe('__TOOLAIRLOCK_TRACE__')
  })
})
