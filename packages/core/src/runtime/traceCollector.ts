import type { RunDeadlinePhase } from '../contracts/deadline'
import type { RunStatus, TaskOutcome } from '../contracts/run'
import { deepClone } from './deepClone'

/** 默认持久化 key；多实例或多应用共存时，通过构造参数覆盖以免互相覆写。 */
export const DEFAULT_TRACE_STORAGE_KEY = 'wandkit:traces:v1'

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
  phase?: RunDeadlinePhase
  budgetMs?: number
  activeElapsedMs?: number
  retryable?: boolean
  writeState?: 'committed' | 'unknown'
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
  outcome?: TaskOutcome
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
    stopReason?: string,
    outcome?: TaskOutcome
  ): void {
    const trace = this.find(runId)
    trace.status = status
    trace.stopReason = stopReason
    trace.outcome = outcome === undefined ? undefined : deepClone(outcome)
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

const RUN_DEADLINE_PHASES: RunDeadlinePhase[] = [
  'page_context',
  'prompt_composition',
  'model_call',
  'write_preparation',
  'write_revalidation',
  'route_navigation',
  'page_adapter_wait',
  'read_execution',
  'navigation_execution',
  'write_execution',
  'ui_effect'
]

function isRunDeadlinePhase(value: unknown): value is RunDeadlinePhase {
  return typeof value === 'string' &&
    RUN_DEADLINE_PHASES.includes(value as RunDeadlinePhase)
}

function isWriteState(value: unknown): value is 'committed' | 'unknown' {
  return value === 'committed' || value === 'unknown'
}

interface OutcomeErrorRecord extends Record<string, unknown> {
  code: string
  message: string
  retryable: boolean
}

function hasOutcomeErrorBase(value: unknown): value is OutcomeErrorRecord {
  return isRecord(value) &&
    typeof value.code === 'string' &&
    typeof value.message === 'string' &&
    typeof value.retryable === 'boolean'
}

function hasOptionalWriteState(value: Record<string, unknown>): boolean {
  return value.writeState === undefined || isWriteState(value.writeState)
}

function isTaskOutcome(value: unknown): value is TaskOutcome {
  if (!isRecord(value) || typeof value.kind !== 'string') return false
  if (value.kind === 'completed' || value.kind === 'needs_input') return true
  if (value.kind === 'cancelled') return value.reason === 'user_stopped'
  if (!hasOutcomeErrorBase(value.error)) return false

  if (value.kind === 'timed_out') {
    return value.error.code === 'RUN_DEADLINE_EXCEEDED' &&
      isRunDeadlinePhase(value.error.phase) &&
      typeof value.error.budgetMs === 'number' &&
      Number.isFinite(value.error.budgetMs) &&
      value.error.budgetMs >= 0 &&
      typeof value.error.activeElapsedMs === 'number' &&
      Number.isFinite(value.error.activeElapsedMs) &&
      value.error.activeElapsedMs >= 0 &&
      hasOptionalWriteState(value.error)
  }

  if (value.kind === 'failed') {
    return [
      'MAX_ROUNDS_REACHED',
      'MAX_TOOL_CALLS_REACHED',
      'TOOL_FAILED',
      'RUNTIME_FAILED'
    ].includes(value.error.code) && hasOptionalWriteState(value.error)
  }

  return false
}

function doesOutcomeMatchStatus(
  outcome: TaskOutcome,
  status: unknown
): boolean {
  if (outcome.kind === 'completed' || outcome.kind === 'needs_input') {
    return status === 'completed'
  }
  if (outcome.kind === 'cancelled') return status === 'cancelled'
  return status === 'failed'
}

function isTraceEvent(value: unknown): value is TraceEvent {
  if (!isRecord(value) || typeof value.type !== 'string') return false
  if (value.names !== undefined && (!Array.isArray(value.names) ||
    !value.names.every(item => typeof item === 'string'))) return false
  if (!isOptionalString(value.functionName) || !isOptionalString(value.toolCallId) ||
    !isOptionalString(value.effectType) || !isOptionalNumber(value.durationMs) ||
    !isOptionalNumber(value.budgetMs) || !isOptionalNumber(value.activeElapsedMs)) return false
  if (value.phase !== undefined && !isRunDeadlinePhase(value.phase)) return false
  if (value.retryable !== undefined && typeof value.retryable !== 'boolean') return false
  if (value.writeState !== undefined && !isWriteState(value.writeState)) return false
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
  if (value.status !== undefined && value.status !== 'completed' &&
    value.status !== 'failed' && value.status !== 'cancelled') return false
  if (value.outcome !== undefined) {
    if (!isTaskOutcome(value.outcome)) return false
    if (!doesOutcomeMatchStatus(value.outcome, value.status)) return false
  }
  return true
}
