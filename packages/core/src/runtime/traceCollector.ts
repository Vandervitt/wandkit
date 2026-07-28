import type { RunStatus } from '../contracts/run'
import { deepClone } from './deepClone'

/** 默认持久化 key；多实例或多应用共存时，通过构造参数覆盖以免互相覆写。 */
export const DEFAULT_TRACE_STORAGE_KEY = 'toolairlock:traces:v1'

/** localStorage 的最小子集，抽出来是为了让测试与非浏览器环境都能注入。 */
export interface TraceStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/**
  * 一条 trace 事件。
  *
  * 字段全部可选、结构扁平，是刻意为之：事件类型会随功能增长，用一个宽松的记录代替
  * 一堆判别联合，能让新增事件不必修改消费方。`type` 是唯一必填项。
  */
export interface TraceEvent {
  type: string
  names?: string[]
  functionName?: string
  toolCallId?: string
  valid?: boolean
  decision?: 'approved' | 'rejected'
  durationMs?: number
  effectType?: string
  summary?: {
    title: string
    rowLabels: string[]
  }
}

/** 单个 Run 的完整审计记录。 */
export interface RunTrace {
  runId: string
  traceId: string
  inputSummary: string
  startedAt: number
  endedAt?: number
  status?: Extract<RunStatus, 'completed' | 'failed' | 'cancelled'>
  stopReason?: string
  events: TraceEvent[]
}

/**
  * 收集并持久化 Run 的执行轨迹。
  *
  * 定位是审计与排障，不是可观测性产品：只留最近 N 个 Run，写在本地存储里，宿主随时
  * 可以取走上报。存储不可用（隐私模式、SSR）时静默降级为纯内存，绝不能因为记不了日志
  * 就把功能本身弄挂。
  */
export class TraceCollector {
  private readonly traces: RunTrace[]
  private readonly maximumRuns: number
  private readonly storage?: TraceStorage
  private readonly storageKey: string

  constructor(
    maximumRuns = 100,
    storage: TraceStorage | undefined = resolveStorage(),
    storageKey: string = DEFAULT_TRACE_STORAGE_KEY
  ) {
    this.maximumRuns = maximumRuns
    this.storage = storage
    this.storageKey = storageKey
    this.traces = this.restore()
    if (this.traces.length > this.maximumRuns) {
      this.traces = this.traces.slice(-this.maximumRuns)
      this.persist()
    }
  }

  /**
   * 开始记录一个 Run。
   *
   * 注意 `inputSummary` 只存长度，不存原文：用户输入里常有手机号、客户名、订单号，
   * 而这份记录会落到浏览器本地存储。审计需要的是「什么时候做了什么操作」，不是
   * 「用户原话是什么」。
   */
  start(runId: string, traceId: string, userInput: string): void {
    this.traces.push({
      runId,
      traceId,
      inputSummary: `[redacted:length=${userInput.length}]`,
      startedAt: Date.now(),
      events: []
    })
    if (this.traces.length > this.maximumRuns) this.traces.shift()
    this.persist()
  }

  record(runId: string, event: TraceEvent): void {
    this.find(runId).events.push(deepClone(event))
    this.persist()
  }

  finish(
    runId: string,
    status: Extract<RunStatus, 'completed' | 'failed' | 'cancelled'>,
    stopReason?: string
  ): void {
    const trace = this.find(runId)
    trace.status = status
    trace.stopReason = stopReason
    trace.endedAt = Date.now()
    this.persist()
  }

  recent(): RunTrace[] {
    return deepClone(this.traces)
  }

  latestSequence(): number {
    return this.traces.reduce((maximum, trace) => {
      const match = /^run-(\d+)$/.exec(trace.runId)
      if (!match) return maximum
      const sequence = Number(match[1])
      return Number.isSafeInteger(sequence) ? Math.max(maximum, sequence) : maximum
    }, 0)
  }

  private find(runId: string): RunTrace {
    const trace = this.traces.find(item => item.runId === runId)
    if (!trace) throw new Error('Trace Run 不存在: ' + runId)
    return trace
  }

  private restore(): RunTrace[] {
    if (!this.storage) return []
    try {
      const serialized = this.storage.getItem(this.storageKey)
      if (!serialized) return []
      const value: unknown = JSON.parse(serialized)
      return Array.isArray(value) ? value.filter(isRunTrace).map(deepClone) : []
    } catch (_error) {
      return []
    }
  }

  private persist(): void {
    if (!this.storage) return
    try {
      this.storage.setItem(this.storageKey, JSON.stringify(this.traces))
    } catch (_error) {
      // localStorage 被禁用或超出配额时，Trace 仍保留在当前内存中。
    }
  }
}

function resolveStorage(): TraceStorage | undefined {
  if (typeof window === 'undefined') return undefined
  try {
    return window.localStorage
  } catch (_error) {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value))
}

function isTraceEvent(value: unknown): value is TraceEvent {
  if (!isRecord(value) || typeof value.type !== 'string') return false
  if (value.names !== undefined && (!Array.isArray(value.names) ||
    !value.names.every(item => typeof item === 'string'))) return false
  if (!isOptionalString(value.functionName) || !isOptionalString(value.toolCallId) ||
    !isOptionalString(value.effectType) || !isOptionalNumber(value.durationMs)) return false
  if (value.valid !== undefined && typeof value.valid !== 'boolean') return false
  if (value.decision !== undefined && value.decision !== 'approved' &&
    value.decision !== 'rejected') return false
  if (value.summary !== undefined) {
    if (!isRecord(value.summary) || typeof value.summary.title !== 'string' ||
      !Array.isArray(value.summary.rowLabels) ||
      !value.summary.rowLabels.every(item => typeof item === 'string')) return false
  }
  return true
}

function isRunTrace(value: unknown): value is RunTrace {
  if (!isRecord(value) || typeof value.runId !== 'string' ||
    typeof value.traceId !== 'string' ||
    typeof value.inputSummary !== 'string' ||
    !/^\[redacted:length=\d+\]$/.test(value.inputSummary) ||
    typeof value.startedAt !== 'number' || !Number.isFinite(value.startedAt) ||
    !isOptionalNumber(value.endedAt) || !isOptionalString(value.stopReason) ||
    !Array.isArray(value.events) || !value.events.every(isTraceEvent)) return false
  return value.status === undefined || value.status === 'completed' ||
    value.status === 'failed' || value.status === 'cancelled'
}
