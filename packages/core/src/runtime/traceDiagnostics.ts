import type { RunTrace } from './traceCollector'
import type { TraceCollector } from './traceCollector'

/** 一组 trace 的聚合统计，供开发者在控制台快速判断整体健康度。 */
export interface TraceDiagnosticsSummary {
  runs: number
  completed: number
  failed: number
  cancelled: number
  toolSucceeded: number
  toolFailed: number
  toolSuccessRate: number | null
}

/** 挂到全局上的诊断接口。 */
export interface TraceDiagnosticsApi {
  recent(): RunTrace[]
  summary(): TraceDiagnosticsSummary
  exportJson(): string
}

/** 挂载目标，通常是 `window`；抽成接口是为了让测试能传一个普通对象。 */
/**
 * 挂载目标，通常是 `window`；抽成类型是为了让测试能传一个普通对象。
 *
 * 取 `object` 而非带索引签名的形状：`Window` 本身没有索引签名，用索引签名反而会让
 * `window` 传不进来。写属性时的类型转换收在 {@link installTraceDiagnostics} 内部一处。
 */
export type TraceDiagnosticsTarget = object

/**
 * 挂到全局上的属性名默认值。
 *
 * 宿主可以覆盖：开发者在控制台里敲的是哪个名字属于团队的肌肉记忆，接入本包不该
 * 把它改掉。
 */
export const DEFAULT_TRACE_GLOBAL_KEY = '__TOOLAIRLOCK_TRACE__'

/**
 * 把只读的 trace 诊断接口挂到全局。
 *
 * 用 `Object.freeze` 冻结，并且只暴露读取方法：诊断入口绝不能变成一条能改写运行时
 * 状态的旁路。
 *
 * `enabled` 由宿主决定（通常是「非生产环境」）。生产环境不挂载，因为 trace 里含有
 * 业务参数，不该让任何打开控制台的人随手导出。
 */
export function installTraceDiagnostics(
  target: TraceDiagnosticsTarget,
  traces: TraceCollector,
  enabled: boolean,
  globalKey: string = DEFAULT_TRACE_GLOBAL_KEY
): void {
  if (!enabled) return
  ;(target as Record<string, unknown>)[globalKey] = Object.freeze({
    recent: () => traces.recent(),
    summary: () => summarizeTraces(traces.recent()),
    exportJson: () => JSON.stringify(traces.recent(), null, 2)
  })
}

export function summarizeTraces(traces: readonly RunTrace[]): TraceDiagnosticsSummary {
  const toolSucceeded = countEvents(traces, 'tool_succeeded')
  const toolFailed = countEvents(traces, 'tool_failed')
  const toolRuns = toolSucceeded + toolFailed
  return {
    runs: traces.length,
    completed: traces.filter(trace => trace.status === 'completed').length,
    failed: traces.filter(trace => trace.status === 'failed').length,
    cancelled: traces.filter(trace => trace.status === 'cancelled').length,
    toolSucceeded,
    toolFailed,
    toolSuccessRate: toolRuns === 0 ? null : toolSucceeded / toolRuns
  }
}

function countEvents(traces: readonly RunTrace[], eventType: string): number {
  return traces.reduce((total, trace) => {
    return total + trace.events.filter(event => event.type === eventType).length
  }, 0)
}
