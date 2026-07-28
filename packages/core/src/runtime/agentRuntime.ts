import {
  formatMessage,
  resolveMessages,
  type AirlockMessages
} from '../config/messages'
import type { LlmMessage } from '../contracts/llm'
import type { ModuleDefinition } from '../contracts/module'
import { toOpenAIToolDefinition } from '../contracts/openAITool'
import {
  isCancelledResult,
  ToolPreparationError,
  ToolPreparationNotice,
  type PreparedAction,
  type ToolResult
} from '../contracts/result'
import type { RunSnapshot, RunStatus } from '../contracts/run'
import type { ToolDefinition, ToolExecutionContext } from '../contracts/tool'
import type { ResolveCandidatesOptions } from '../discovery/candidateResolver'
import {
  applyMessageBudget,
  MAX_CANDIDATE_MODULES,
  MAX_EXPOSED_TOOLS,
  selectToolsWithinBudget
} from '../discovery/budget'
import { filterAuthorizedTools } from '../discovery/permissionFilter'
import type { ActionRouter } from '../execution/actionRouter'
import {
  ConfirmationManager,
  type ConfirmationRequest,
  type PendingPreparedCall
} from '../execution/confirmationManager'
import type { ToolRegistry } from '../registry/toolRegistry'
import type { ComposePromptOptions } from './promptComposer'
import { ConversationStore } from './conversationStore'
import { deepClone } from './deepClone'
import { normalizeLlmAssistantMessage } from './llmResponseNormalizer'
import {
  cancelledResult,
  executionFailureResult,
  invalidInputResult,
  parseToolArguments
} from './resultNormalizer'
import { transition, type RunEvent } from './runStateMachine'
import { TraceCollector } from './traceCollector'

/**
 * Runtime 推给宿主界面的事件。
 *
 * 单向：Runtime 只发不收，宿主通过 `start` / `confirm` / `cancel` / `stop` 这几个
 * 方法回话。这样界面永远拿不到可以直接改的运行时状态。
 */
export interface RuntimeUiEvent {
  type: 'state' | 'assistant' | 'confirmation' | 'tool_result' | 'clear'
  snapshot?: RunSnapshot
  activeModuleIds?: string[]
  content?: string | null
  confirmation?: ConfirmationRequest
  toolCallId?: string
  result?: ToolResult
  cancelled?: boolean
}

/**
 * Runtime 需要宿主提供的一切。
 *
 * 全部以依赖注入方式传入，没有任何一项是包内单例——这既让 Runtime 可测，也让同一个
 * 应用里跑多个互不干扰的 Runtime 成为可能。
 */
export interface AgentRuntimeDependencies {
  llm: {
    chat: (messages: LlmMessage[], tools: unknown[], signal?: AbortSignal) => Promise<{
      role: 'assistant'
      content: string | null
      tool_calls?: Array<{
        id: string
        type: 'function'
        function: { name: string, arguments: string }
      }>
    }>
  }
  registry: ToolRegistry
  resolveCandidates(options: ResolveCandidatesOptions): string[]
  composePrompt(options: ComposePromptOptions): Promise<LlmMessage[]>
  actionRouter: ActionRouter
  getRouteName(): string | undefined
  getPermissions(): string[]
  /**
   * 该模块已挂载页面的结构化快照；没有页面挂载时返回 `null`。
   *
   * 允许同步返回：{@link PageAdapter.getContext} 本身就可同步可异步，宿主常写成
   * `adapters.get(moduleId, routeName)?.getContext() ?? null`，不该被迫包一层
   * `Promise.resolve`。Runtime 一律 `await` 后再判 `null`。
   */
  getPageContext(moduleId: string): unknown | Promise<unknown>
  emit(event: RuntimeUiEvent): void
}

export interface AgentRuntimeOptions {
  maxRounds?: number
  maxToolCalls?: number
  runTimeoutMs?: number
  now?: () => number
  traces?: TraceCollector
  /** 覆盖面向用户的话术；缺省用内置中文。 */
  messages?: Partial<AirlockMessages>
  /**
   * 一轮内最多激活多少个模块，缺省 {@link MAX_CANDIDATE_MODULES}。
   *
   * 设成模块总数即「全局接入」：任何模块都不会因为用户措辞或所在页面而够不到。
   * 需与 {@link maxExposedTools} 一起放开，否则模块进来了、工具仍会被二次截断。
   * 放开的代价是模型每轮在更多工具里挑，选错概率上升——请按自身模块规模权衡。
   */
  maxCandidateModules?: number
  /** 一轮内最多暴露多少个工具，缺省 {@link MAX_EXPOSED_TOOLS}。 */
  maxExposedTools?: number
}

/** 单次 Run 的可变状态。生命周期内始终是同一个对象。 */
interface ActiveRun {
  runId: string
  traceId: string
  userInput: string
  status: RunStatus
  startedAt: number
  rounds: number
  toolCalls: number
  modelCorrectionAttempts: number
  seenToolCallIds: Set<string>
  activatedModuleIds: string[]
  previousModuleIds: string[]
  permissions: string[]
  pageContext?: unknown
  abortController: AbortController
  stopped: boolean
  timedOut: boolean
  pendingToolCallIds: string[]
  lastToolCallId?: string
  /**
   * 上一轮有工具报了「还缺用户没给的信息」。
   *
   * 置位后下一轮不暴露任何工具，逼模型开口问——实测中它拿到「缺少必填项」的结果后，
   * 会把单价、并发量这类只有用户知道的值凭空编出来再试一次，提示词拦不住。
   */
  needsUserInput: boolean
  // 执行超时只应度量「主动处理耗时」，人工确认等待时长通过 pausedMs 从预算中扣除，
  // 避免用户确认慢导致写入执行后 Run 又被误判为超时失败（诱导重复提交）。
  pausedMs: number
  awaitingSince?: number
}

interface PreparedCallOutcome {
  pending?: PendingPreparedCall
  failure?: ToolResult
}

interface RefreshedPreparedCall {
  prepared?: PreparedAction
  result?: ToolResult
}

/**
 * Run 终止的原因，带一个参与控制流的类别标记。
 *
 * `kind` 存在的意义就是让调度逻辑不必去解析 `message`：文案由宿主覆盖、可本地化，
 * 一旦成为分支依据，翻译一句话就能静默改变执行语义。
 */
interface RunFailure {
  kind: 'timeout' | 'max_rounds' | 'tool_failure' | 'run_failed'
  message: string
}

const terminalStatuses: RunStatus[] = ['completed', 'failed', 'cancelled']

/**
 * 调度器：把用户的一句话，变成一串受管控的工具调用。
 *
 * 一轮循环做的事：解析候选模块 → 按权限过滤工具 → 调模型 → 分派工具调用 → 回喂结果，
 * 直到模型不再要求调工具，或撞上某条限额。
 *
 * 几条贯穿全类、值得单独记住的规则：
 *
 * - **写操作在本轮只做 prepare。** 模型提出的写调用一律先挂起等确认；真正的执行在
 *   用户批准后由 {@link confirm} 触发，且会重跑 prepare 做比对。
 * - **等待确认的时间不计入超时。** 见 `pausedMs`。人确认得慢导致 Run 超时失败，会直接
 *   诱发重复提交，是这类系统最典型的事故链。
 * - **失败会中止整轮。** 一个工具失败后，同轮剩余调用全部补上「未执行」的结果再终止——
 *   工具调用协议要求每个 `tool_call_id` 都有对应的 tool 消息，缺一条整条历史就废了。
 * - **模型选错工具不算失败。** 回一条带可用工具清单的软失败，让它下一轮自己改正；
 *   轮次和调用数上限负责兜住死循环。
 */
export class AgentRuntime {
  private readonly historyStore = new ConversationStore()
  private readonly confirmations = new ConfirmationManager()
  private readonly maxRounds: number
  private readonly maxToolCalls: number
  private readonly runTimeoutMs: number
  private readonly now: () => number
  private readonly messages: AirlockMessages
  private readonly maxCandidateModules: number
  private readonly maxExposedTools: number
  private readonly skippedAfterFailureResult: ToolResult
  private readonly skippedForModelCorrectionResult: ToolResult
  private active?: ActiveRun
  private lastSnapshot: RunSnapshot = { runId: '', traceId: '', status: 'idle' }
  private previousModuleIds: string[] = []
  private sequence: number
  readonly traces: TraceCollector

  constructor(
    private readonly dependencies: AgentRuntimeDependencies,
    options: AgentRuntimeOptions = {}
  ) {
    this.maxRounds = options.maxRounds ?? 6
    this.maxToolCalls = options.maxToolCalls ?? 12
    this.runTimeoutMs = options.runTimeoutMs ?? 60000
    this.now = options.now ?? Date.now
    this.messages = resolveMessages(options.messages)
    this.maxCandidateModules = options.maxCandidateModules ?? MAX_CANDIDATE_MODULES
    this.maxExposedTools = options.maxExposedTools ?? MAX_EXPOSED_TOOLS
    this.skippedAfterFailureResult = {
      ok: false,
      message: this.messages.skippedAfterFailure
    }
    this.skippedForModelCorrectionResult = {
      ok: false,
      message: this.messages.skippedForModelCorrection
    }
    this.traces = options.traces ?? new TraceCollector()
    this.sequence = this.traces.latestSequence()
  }

  get history(): readonly LlmMessage[] {
    return this.historyStore.messages
  }

  snapshot(): RunSnapshot {
    return { ...this.lastSnapshot }
  }

  currentConfirmation(): ConfirmationRequest | undefined {
    return this.confirmations.current()
  }

  /**
   * 用一句用户输入启动新的 Run。
   *
   * @throws 已有 Run 正在执行或正等待确认时抛出。刻意不排队：并发的 Run 会互相争夺
   *   同一个页面和同一份会话历史。
   */
  async start(userInput: string): Promise<RunSnapshot> {
    if (this.active && !terminalStatuses.includes(this.active.status)) {
      if (this.active.status === 'awaiting_confirmation') {
        throw new Error('当前 Run 正在等待确认')
      }
      throw new Error('当前 Run 正在执行')
    }

    const id = ++this.sequence
    const run: ActiveRun = {
      runId: 'run-' + id,
      traceId: 'trace-' + id,
      userInput,
      status: 'idle',
      startedAt: this.now(),
      rounds: 0,
      toolCalls: 0,
      modelCorrectionAttempts: 0,
      seenToolCallIds: new Set(),
      activatedModuleIds: [],
      previousModuleIds: [...this.previousModuleIds],
      permissions: this.dependencies.getPermissions(),
      abortController: new AbortController(),
      stopped: false,
      timedOut: false,
      pendingToolCallIds: [],
      needsUserInput: false,
      pausedMs: 0
    }
    this.active = run
    this.confirmations.clear()
    this.historyStore.markSafePoint()
    this.historyStore.push({ role: 'user', content: userInput })
    this.traces.start(run.runId, run.traceId, userInput)
    this.transitionRun(run, { type: 'START' })
    return this.runLoop(run)
  }

  /**
   * 批准当前待确认的写操作，并执行它。
   *
   * 这是全包**唯一**会真正写数据的入口。执行前还要过两道关：工具仍然存在且仍是写工具，
   * 以及重跑 `prepare` 的结果与用户批准过的内容一致（{@link refreshPreparedCall}）。
   *
   * @throws 当前没有待确认项时抛出。
   */
  async confirm(confirmationId: string): Promise<RunSnapshot> {
    const run = this.requireAwaitingRun()
    // 先校验、后停表：ID 不是队首时 `approve` 会抛，此时 Run 仍在等待确认。
    // 顺序反过来会把等待计时永久关掉（`beginAwaiting` 只在弹出下一张卡片时才重新
    // 武装），于是一次误点就让后续的人工等待重新计入超时预算——正是 `pausedMs`
    // 要防的那条「确认慢 → Run 超时 → 诱导重复提交」的事故链。
    const pending = this.confirmations.approve(confirmationId)
    this.endAwaiting(run)
    this.traces.record(run.runId, {
      type: 'confirmation',
      functionName: pending.functionName,
      toolCallId: pending.toolCallId,
      decision: 'approved'
    })
    this.transitionRun(run, { type: 'CONFIRM' })
    const tool = this.dependencies.registry.get(pending.functionName)
    if (!tool || (tool.risk !== 'write' && tool.risk !== 'destructive')) {
      const result = executionFailureResult(
        new Error(this.messages.staleConfirmationTool),
        this.messages
      )
      this.recordToolResult(run, pending.toolCallId, pending.functionName, result)
      return this.failAfterToolFailure(run, result.message)
    }

    const refreshed = await this.refreshPreparedCall(run, tool, pending)
    if (this.isInactive(run)) return this.toSnapshot(run)
    if (refreshed.result) {
      this.recordToolResult(
        run,
        pending.toolCallId,
        pending.functionName,
        refreshed.result
      )
      if (!refreshed.result.ok) {
        return this.failAfterToolFailure(run, refreshed.result.message)
      }
      this.transitionRun(run, { type: 'PREPARE_COMPLETED' }, false)
      return this.continueAfterConfirmation(run)
    }

    this.transitionRun(run, { type: 'WRITE_VALIDATED' })

    let result: ToolResult
    const startedAt = this.now()
    try {
      result = await this.dependencies.actionRouter.execute({
        tool,
        context: this.createToolContext(run),
        input: undefined,
        prepared: refreshed.prepared,
        requestId: pending.confirmationId
      })
    } catch (error) {
      result = executionFailureResult(error, this.messages)
    }
    this.recordToolResult(
      run,
      pending.toolCallId,
      pending.functionName,
      result,
      startedAt,
      { allowStoppedUi: true, cancelled: isCancelledResult(result) }
    )
    if (run.stopped || this.active !== run) return this.toSnapshot(run)
    this.transitionRun(run, { type: 'WRITE_COMPLETED' }, false)
    if (!result.ok && !isCancelledResult(result)) {
      return this.failAfterToolFailure(run, result.message)
    }

    return this.continueAfterConfirmation(run)
  }

  /**
   * 拒绝当前待确认的写操作。
   *
   * 关键在于：拒绝不会静默关掉弹窗了事，而是把「人类拒绝了此操作」作为工具结果回喂给
   * 模型。模型据此中止原本的推理，而不是换个参数再试一次。
   *
   * 队列里还有其它待确认项时，接着弹下一个；否则回到主循环让模型继续。
   */
  async cancel(confirmationId: string): Promise<RunSnapshot> {
    const run = this.requireAwaitingRun()
    // 与 {@link confirm} 同理：先校验 ID，通过之后才停止等待计时。
    const pending = this.confirmations.reject(confirmationId)
    this.endAwaiting(run)
    this.traces.record(run.runId, {
      type: 'confirmation',
      functionName: pending.functionName,
      toolCallId: pending.toolCallId,
      decision: 'rejected'
    })
    this.transitionRun(run, { type: 'CONFIRMATION_REJECTED' }, false)
    this.recordToolResult(
      run,
      pending.toolCallId,
      pending.functionName,
      cancelledResult(this.messages.cancelled),
      undefined,
      { cancelled: true }
    )

    const next = this.confirmations.advance()
    if (next) {
      this.transitionRun(run, { type: 'AWAIT_CONFIRMATION' }, false)
      this.publishConfirmation(run, next)
      return this.toSnapshot(run)
    }

    this.publishState(run)
    return this.runLoop(run)
  }

  /**
   * 立刻停止当前 Run。
   *
   * 会回滚会话历史到安全点：中途停止时，历史里很可能留着一条带 `tool_calls` 却没有
   * 对应 tool 消息的 assistant 消息，那在协议上非法，会污染下一个 Run。
   *
   * 已经发出的写请求拦不住——`abort` 只切断我们这一侧的等待。这正是
   * `writeState: 'unknown'` 存在的意义。
   */
  stop(): void {
    const run = this.active
    if (!run || terminalStatuses.includes(run.status)) return
    run.stopped = true
    run.abortController.abort()
    this.confirmations.clear()
    this.historyStore.rollbackToSafePoint()
    this.finish(run, 'cancelled', this.messages.stoppedByUser)
  }

  /**
   * 清空会话，回到初始状态。
   *
   * @throws 有 Run 未结束时抛出。清空一个进行中的 Run 会让在途工具的结果无处归属。
   */
  clear(): void {
    if (this.active && !terminalStatuses.includes(this.active.status)) {
      throw new Error('当前 Run 尚未结束，请先停止或处理确认')
    }
    this.historyStore.clear()
    this.confirmations.clear()
    this.active = undefined
    this.previousModuleIds = []
    this.lastSnapshot = { runId: '', traceId: '', status: 'idle' }
    this.dependencies.emit({
      type: 'clear',
      snapshot: { ...this.lastSnapshot },
      activeModuleIds: []
    })
  }

  /**
   * 主循环：一轮模型调用 + 一批工具分派，直到终止。
   *
   * 每轮开头都重新解析候选模块并重新按权限过滤工具——上一轮的工具可能通过
   * `activateModules` 改变了作用域。
   *
   * 权限则相反：`run.permissions` 在 {@link start} 时快照一次，整个 Run 内冻结。
   * 一次 Run 是一个语义整体，中途权限变动会让前后几轮基于不同的可见工具集推理，
   * 产出前后矛盾的结果；变动会在下一个 Run 生效。
   */
  private async runLoop(run: ActiveRun): Promise<RunSnapshot> {
    try {
      while (this.active === run && !run.stopped) {
        const limitReason = this.limitReason(run)
        if (limitReason) return this.fail(run, limitReason)

        const candidates = this.resolveAuthorizedCandidates(run)
        run.previousModuleIds = candidates
        const modules = candidates
          .map(moduleId => this.dependencies.registry.modules.get(moduleId))
          .filter((module): module is ModuleDefinition => Boolean(module))
        const tools = this.resolveAuthorizedTools(candidates, run.permissions)
        this.traces.record(run.runId, { type: 'candidates', names: candidates })

        if (run.status === 'resolving_tools') {
          this.transitionRun(run, { type: 'TOOLS_RESOLVED' })
        } else {
          this.publishState(run)
        }
        const pageContext = await this.resolvePageContext(run, modules)
        if (this.isInactive(run)) return this.toSnapshot(run)
        run.pageContext = pageContext?.value
        const messages = await this.dependencies.composePrompt({
          activeModules: modules,
          pageContext,
          history: this.historyStore.messages
        })
        if (this.isInactive(run)) return this.toSnapshot(run)

        this.traces.record(run.runId, {
          type: 'model_request',
          names: tools.map(tool => tool.functionName)
        })
        // 上一轮有工具明确要用户补信息，这一轮就不给工具——没有工具可调，
        // 模型只能用自然语言把缺什么讲清楚。用完即清，下一轮恢复正常。
        const exposedTools = run.needsUserInput ? [] : tools.map(({ schema }) => schema)
        run.needsUserInput = false
        // 兼容那些不稳定填 tool_calls、把调用直接吐在 content 里的模型（多见于小
        // 参数量模型）。判定口径很窄，且只认本轮真实暴露过的工具名，因此救援不会
        // 成为绕过权限过滤的旁路，详见 normalizeLlmAssistantMessage。
        const assistant = normalizeLlmAssistantMessage(
          await this.chatWithDeadline(
            run,
            applyMessageBudget(messages),
            exposedTools
          ),
          exposedTools
        )
        if (this.isInactive(run)) return this.toSnapshot(run)
        this.traces.record(run.runId, {
          type: 'model_response',
          names: (assistant.tool_calls || []).map(call => call.function.name)
        })
        run.rounds += 1
        this.historyStore.push(assistant)

        const calls = assistant.tool_calls ?? []
        if (this.active === run) {
          // 有工具调用的轮次不渲染模型内部 content（可能是思维链/中间推理），
          // 仅在最终回答轮（无 tool_calls）向用户展示 content。
          this.dependencies.emit({
            type: 'assistant',
            content: calls.length > 0 ? null : assistant.content
          })
        }

        run.pendingToolCallIds = calls.map(call => call.id)
        if (calls.length === 0) return this.finish(run, 'completed')

        const preparedCalls: PendingPreparedCall[] = []
        let retryModel = false
        for (const call of calls) {
          if (this.isInactive(run)) return this.toSnapshot(run)
          run.lastToolCallId = call.id
          if (run.seenToolCallIds.has(call.id)) {
            const result = {
              ok: false,
              message: this.messages.duplicateToolCall
            }
            this.recordToolResult(run, call.id, call.function.name, result)
            return this.failAfterToolFailure(run, result.message)
          }
          run.seenToolCallIds.add(call.id)

          if (run.toolCalls >= this.maxToolCalls) {
            const reason = formatMessage(
              this.messages.maxToolCallsReached,
              { limit: this.maxToolCalls }
            )
            this.recordToolResult(run, call.id, call.function.name, { ok: false, message: reason })
            return this.failAfterToolFailure(run, reason)
          }
          run.toolCalls += 1

          const parsed = parseToolArguments(call.function.arguments, this.messages)
          if (!parsed.ok) {
            this.traces.record(run.runId, {
              type: 'validation', functionName: call.function.name, toolCallId: call.id, valid: false
            })
            if (this.handleModelArgumentFailure(
              run,
              calls,
              call.id,
              call.function.name,
              parsed.result
            )) {
              retryModel = true
              break
            }
            this.recordToolResult(run, call.id, call.function.name, parsed.result)
            return this.failAfterToolFailure(run, parsed.result.message)
          }

          const tool = tools.find(item => item.functionName === call.function.name)?.tool
          if (!tool) {
            // 模型选错工具（调用了当前未暴露的工具）不应直接终止 Run：回写一条带
            // 可用工具清单的软失败结果，让模型在下一轮改用正确工具自我纠正。
            // maxToolCalls / maxRounds 上限仍会兜底，避免模型反复调错导致死循环。
            const available = tools.map(item => item.functionName).join('、')
            const result = {
              ok: false,
              message: formatMessage(this.messages.toolUnavailable, {
                name: call.function.name,
                available: available || this.messages.noToolAvailable
              })
            }
            this.recordToolResult(run, call.id, call.function.name, result)
            continue
          }
          try {
            this.dependencies.registry.validateInput(call.function.name, parsed.value)
            this.traces.record(run.runId, {
              type: 'validation', functionName: call.function.name, toolCallId: call.id, valid: true
            })
          } catch (error) {
            this.traces.record(run.runId, {
              type: 'validation', functionName: call.function.name, toolCallId: call.id, valid: false
            })
            const result = invalidInputResult(error, this.messages)
            if (this.handleModelArgumentFailure(
              run,
              calls,
              call.id,
              call.function.name,
              result
            )) {
              retryModel = true
              break
            }
            this.recordToolResult(run, call.id, call.function.name, result)
            return this.failAfterToolFailure(run, result.message)
          }

          if (tool.risk === 'write' || tool.risk === 'destructive') {
            const outcome = await this.prepareWrite(
              run,
              tool,
              call.id,
              call.function.name,
              parsed.value
            )
            if (this.isInactive(run)) return this.toSnapshot(run)
            if (outcome.failure) {
              return this.failAfterToolFailure(run, outcome.failure.message)
            }
            if (outcome.pending) preparedCalls.push(outcome.pending)
          } else {
            const result = await this.executeRead(
              run,
              tool,
              call.id,
              call.function.name,
              parsed.value
            )
            if (this.isInactive(run)) return this.toSnapshot(run)
            if (
              result && !result.ok &&
              !isCancelledResult(result) && !result.needsUserInput
            ) {
              return this.failAfterToolFailure(run, result.message)
            }
          }
        }

        if (this.isInactive(run)) return this.toSnapshot(run)
        if (retryModel) continue
        if (preparedCalls.length > 0) {
          const confirmation = this.confirmations.enqueue(preparedCalls)
          this.transitionRun(run, { type: 'AWAIT_CONFIRMATION' }, false)
          if (confirmation) this.publishConfirmation(run, confirmation)
          return this.toSnapshot(run)
        }
      }
      return this.toSnapshot(run)
    } catch (error) {
      if (run.stopped || this.active !== run) {
        if (!terminalStatuses.includes(run.status)) {
          this.historyStore.rollbackToSafePoint()
          return this.finish(run, 'cancelled', this.messages.stoppedByUser)
        }
        return this.toSnapshot(run)
      }
      if (run.timedOut) {
        return this.fail(run, {
          kind: 'timeout',
          message: formatMessage(this.messages.runTimeout, { ms: this.runTimeoutMs })
        })
      }
      if (error instanceof Error && error.name === 'AbortError') {
        this.historyStore.rollbackToSafePoint()
        return this.finish(run, 'cancelled', this.messages.stoppedByUser)
      }
      return this.fail(run, { kind: 'run_failed', message: this.messages.runFailed })
    }
  }

  private resolveAuthorizedCandidates(run: ActiveRun): string[] {
    return this.dependencies.resolveCandidates({
      text: run.userInput,
      routeName: this.dependencies.getRouteName(),
      modules: this.dependencies.registry.modules.getAll(),
      permissions: run.permissions,
      activatedModuleIds: run.activatedModuleIds,
      previousModuleIds: run.previousModuleIds
    }).slice(0, this.maxCandidateModules)
  }

  private resolveAuthorizedTools(moduleIds: string[], permissions: string[]): Array<{
    functionName: string
    tool: ToolDefinition
    schema: unknown
  }> {
    const toolGroups = moduleIds.map(moduleId => filterAuthorizedTools(
      this.dependencies.registry.getByModule(moduleId),
      permissions
    ))
    return selectToolsWithinBudget(toolGroups, this.maxExposedTools)
      .map(tool => {
        const schema = toOpenAIToolDefinition(tool)
        return {
          functionName: schema.function.name,
          tool,
          schema
        }
      })
  }

  /**
   * 取候选模块中第一个真正拿得到页面快照的上下文。
   *
   * 刻意遍历而不是只看 `modules[0]`：候选优先级里「别名精确命中」排在「当前路由」
   * 之前，因此排第一的模块经常并不是用户眼前那个页面（例如站在话单页说「查一下
   * 用户」）。只看首位会让页面快照整个丢失，而模型恰恰要靠它把「张三」解析成 id。
   */
  private async resolvePageContext(
    run: ActiveRun,
    modules: ModuleDefinition[]
  ): Promise<{
    moduleId: string
    value: unknown
  } | undefined> {
    for (const module of modules) {
      const value = await this.dependencies.getPageContext(module.id)
      // 每个 await 之间 Run 都可能已被停止，别再去问后续模块要快照。
      if (this.isInactive(run)) return undefined
      if (value !== null) return { moduleId: module.id, value }
    }
    return undefined
  }

  /**
   * 跑写工具的 prepare 阶段，产出待确认项。
   *
   * 此处**绝不**执行写入。两种受控的提前退出：{@link ToolPreparationNotice} 表示
   * 「无事可做」的成功（不该为一个空操作去打扰用户），{@link ToolPreparationError}
   * 表示带自定义文案的失败。
   */
  private async prepareWrite(
    run: ActiveRun,
    tool: ToolDefinition,
    toolCallId: string,
    functionName: string,
    input: unknown
  ): Promise<PreparedCallOutcome> {
    if (tool.risk !== 'write' && tool.risk !== 'destructive') return {}
    if (this.isInactive(run)) return {}
    this.transitionRun(run, { type: 'PREPARE_WRITE' })
    try {
      const prepared = await tool.prepare(this.createToolContext(run), input)
      if (this.isInactive(run)) return {}
      this.traces.record(run.runId, {
        type: 'prepared',
        functionName,
        toolCallId,
        summary: { title: prepared.title, rowLabels: prepared.rows.map(row => row.label) }
      })
      this.transitionRun(run, { type: 'PREPARE_COMPLETED' }, false)
      return {
        pending: {
          confirmationId: `${run.runId}:${toolCallId}`,
          toolCallId,
          functionName,
          input: deepClone(input),
          prepared,
          risk: tool.risk
        }
      }
    } catch (error) {
      if (error instanceof ToolPreparationNotice) {
        this.recordToolResult(run, toolCallId, functionName, error.result)
        this.transitionRun(run, { type: 'PREPARE_COMPLETED' }, false)
        return {}
      }
      const result = error instanceof ToolPreparationError
        ? error.result
        : executionFailureResult(error, this.messages)
      this.recordToolResult(run, toolCallId, functionName, result)
      // 缺信息不是失败：结果已回喂给模型，让它向用户追问，Run 继续。
      if (result.needsUserInput) {
        this.transitionRun(run, { type: 'PREPARE_COMPLETED' }, false)
        return {}
      }
      return { failure: result }
    }
  }

  /** 执行读 / 导航类工具——即无需人工确认的那些。 */
  private async executeRead(
    run: ActiveRun,
    tool: ToolDefinition,
    toolCallId: string,
    functionName: string,
    input: unknown
  ): Promise<ToolResult | undefined> {
    if (this.isInactive(run)) return undefined
    const isNavigation = tool.risk === 'navigation'
    this.transitionRun(run, { type: isNavigation ? 'NAVIGATE' : 'EXECUTE_READ' })
    const startedAt = this.now()
    let result: ToolResult
    try {
      result = await this.dependencies.actionRouter.execute({
        tool,
        context: this.createToolContext(run),
        input,
        requestId: `${run.runId}:${toolCallId}`
      })
    } catch (error) {
      result = executionFailureResult(error, this.messages)
    }
    this.recordToolResult(run, toolCallId, functionName, result, startedAt)
    if (!this.isInactive(run)) {
      this.transitionRun(
        run,
        { type: isNavigation ? 'NAVIGATION_COMPLETED' : 'READ_COMPLETED' },
        false
      )
    }
    return result
  }

  /**
   * 确认时重跑 prepare，并与用户批准过的内容比对。
   *
   * 这是对 TOCTOU 的封堵：确认卡片可能已经在屏幕上停了几十秒，期间别人完全可能改动
   * 同一条数据。不比对的话，用户批准的是 A，落下去的是 B。
   */
  private async refreshPreparedCall(
    run: ActiveRun,
    tool: ToolDefinition,
    pending: PendingPreparedCall
  ): Promise<RefreshedPreparedCall> {
    if (tool.risk !== 'write' && tool.risk !== 'destructive') {
      return {
        result: executionFailureResult(
          new Error(this.messages.staleConfirmationTool),
          this.messages
        )
      }
    }
    try {
      const prepared = await tool.prepare(
        this.createToolContext(run),
        deepClone(pending.input)
      )
      if (!this.sameConfirmationContent(pending.prepared, prepared)) {
        return {
          result: {
            ok: false,
            message: this.messages.confirmationContentChanged
          }
        }
      }
      return { prepared }
    } catch (error) {
      if (error instanceof ToolPreparationNotice) return { result: error.result }
      return {
        result: error instanceof ToolPreparationError
          ? error.result
          : executionFailureResult(error, this.messages)
      }
    }
  }

  /**
   * 判断两次 prepare 的展示内容是否一致。
   *
   * 只比 `title` / `rows` / `impact` / `rawRequest`，**不比** `payload`：这场比对针对的
   * 是「人类看到并同意了什么」。一个没改变展示语义的内部 payload 细节，不该让用户的
   * 同意作废；而 `rawRequest` 恰恰相反——它就是点下确认后要发出去的那个请求，被偷换了
   * 就等于拿着 A 的同意去发 B，因此必须参与比对。
   */
  private sameConfirmationContent(
    previous: PreparedAction,
    refreshed: PreparedAction
  ): boolean {
    return JSON.stringify({
      title: previous.title,
      rows: previous.rows,
      impact: previous.impact,
      rawRequest: previous.rawRequest
    }) === JSON.stringify({
      title: refreshed.title,
      rows: refreshed.rows,
      impact: refreshed.impact,
      rawRequest: refreshed.rawRequest
    })
  }

  private continueAfterConfirmation(run: ActiveRun): Promise<RunSnapshot> | RunSnapshot {
    const next = this.confirmations.advance()
    if (next) {
      this.transitionRun(run, { type: 'AWAIT_CONFIRMATION' }, false)
      this.publishConfirmation(run, next)
      return this.toSnapshot(run)
    }

    this.publishState(run)
    return this.runLoop(run)
  }

  /**
   * 给模型一次、且仅一次修正参数的机会。
   *
   * 参数错时不立刻判 Run 失败，而是把错误回喂让它重试一轮。`modelCorrectionAttempts`
   * 上限为 1：模型改一次还错，通常是 Schema 本身有问题，继续重试只是烧钱。
   *
   * 同轮其余调用会被补上「未执行」的结果——协议要求每个 `tool_call_id` 都有应答。
   *
   * @returns 是否已进入纠正流程（调用方据此重开一轮）。
   */
  private handleModelArgumentFailure(
    run: ActiveRun,
    calls: ReadonlyArray<{ id: string, function: { name: string } }>,
    toolCallId: string,
    functionName: string,
    result: ToolResult
  ): boolean {
    if (run.modelCorrectionAttempts >= 1) return false

    run.modelCorrectionAttempts += 1
    this.recordToolResult(run, toolCallId, functionName, result, undefined, {
      silentUi: true
    })
    const skippedToolCallIds = [...run.pendingToolCallIds]
    skippedToolCallIds.forEach(skippedToolCallId => {
      run.seenToolCallIds.add(skippedToolCallId)
      const skippedFunctionName = calls.find(call => call.id === skippedToolCallId)
        ?.function.name ?? 'unknown'
      this.recordToolResult(
        run,
        skippedToolCallId,
        skippedFunctionName,
        this.skippedForModelCorrectionResult,
        undefined,
        { silentUi: true }
      )
    })
    return true
  }

  /**
   * 把一次工具结果同时写进会话历史、trace 和界面事件。
   *
   * 三处刻意不完全同步：`silentUi` 让纠正过程中的中间失败不打扰用户；`allowStoppedUi`
   * 让已停止的 Run 仍能报出写入的最终状态——用户点了停止，但钱可能已经划走了，这时候
   * 沉默才是最坏的选择。
   */
  private recordToolResult(
    run: ActiveRun,
    toolCallId: string,
    functionName: string,
    result: ToolResult,
    startedAt?: number,
    options: { allowStoppedUi?: boolean, cancelled?: boolean, silentUi?: boolean } = {}
  ): void {
    if (this.active !== run) return
    if (run.stopped && !options.allowStoppedUi) return
    if (!run.stopped) this.historyStore.appendToolResult(toolCallId, result)
    const pendingIndex = run.pendingToolCallIds.indexOf(toolCallId)
    if (pendingIndex >= 0) run.pendingToolCallIds.splice(pendingIndex, 1)
    this.traces.record(run.runId, {
      type: result.ok ? 'tool_succeeded' : 'tool_failed',
      functionName,
      toolCallId,
      durationMs: startedAt === undefined ? undefined : Math.max(0, this.now() - startedAt),
      effectType: result.uiEffect?.type
    })
    if (result.needsUserInput) run.needsUserInput = true
    if (!options.silentUi) {
      this.dependencies.emit({
        type: 'tool_result',
        toolCallId,
        result,
        ...(options.cancelled ? { cancelled: true } : {})
      })
    }
  }

  private createToolContext(run: ActiveRun): ToolExecutionContext {
    return {
      runId: run.runId,
      traceId: run.traceId,
      signal: run.abortController.signal,
      currentRouteName: this.dependencies.getRouteName(),
      userInput: run.userInput,
      pageContext: run.pageContext,
      permissions: [...run.permissions],
      activateModules: moduleIds => {
        moduleIds.forEach(moduleId => {
          if (!run.activatedModuleIds.includes(moduleId)) run.activatedModuleIds.push(moduleId)
        })
      }
    }
  }

  private isInactive(run: ActiveRun): boolean {
    return run.stopped || run.abortController.signal.aborted || this.active !== run
  }

  /**
   * 带剩余时间预算地调一次模型。
   *
   * 预算取自 {@link activeElapsed}，即已扣除人工确认等待之后的时间。
   */
  private async chatWithDeadline(
    run: ActiveRun,
    messages: LlmMessage[],
    tools: unknown[]
  ) {
    const remaining = this.runTimeoutMs - this.activeElapsed(run)
    if (remaining <= 0) throw new Error(formatMessage(this.messages.runTimeout, { ms: this.runTimeoutMs }))
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        run.timedOut = true
        run.abortController.abort()
        reject(new Error(formatMessage(this.messages.runTimeout, { ms: this.runTimeoutMs })))
      }, remaining)
    })
    try {
      return await Promise.race([
        this.dependencies.llm.chat(messages, tools, run.abortController.signal),
        timeout
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private limitReason(run: ActiveRun): RunFailure | undefined {
    const elapsed = this.activeElapsed(run)
    if (elapsed > this.runTimeoutMs) {
      return {
        kind: 'timeout',
        message: formatMessage(this.messages.runTimeout, { ms: this.runTimeoutMs })
      }
    }
    if (run.rounds >= this.maxRounds) {
      return {
        kind: 'max_rounds',
        message: formatMessage(this.messages.maxRoundsReached, { limit: this.maxRounds })
      }
    }
    return undefined
  }

  /**
   * 终止 Run 并记录原因。
   *
   * 终止**类别**由 {@link RunFailure.kind} 判定，绝不比对 `message` 文本——文案可被
   * 宿主覆盖、可本地化，一旦参与控制流，改一句话就会静默改变执行语义（与
   * {@link isCancelledResult}、{@link PageWaitTimeoutError} 遵循同一条原则）。
   */
  private fail(run: ActiveRun, failure: RunFailure): RunSnapshot {
    // 仅当最后一个 tool call 仍悬空（尚未补结果）时才追加终止结果，避免对上一轮
    // 已完成的 tool call 重复 append，导致同一 tool_call_id 出现两条 tool 消息
    // （OpenAI tool 协议非法，会污染下一个 Run 的历史）。
    if (
      run.lastToolCallId &&
      failure.kind === 'max_rounds' &&
      run.pendingToolCallIds.includes(run.lastToolCallId)
    ) {
      this.historyStore.appendToolResult(
        run.lastToolCallId,
        { ok: false, message: failure.message }
      )
    }
    return this.finish(run, 'failed', failure.message)
  }

  /**
   * 某个工具失败后终止 Run，并把同轮剩余调用补齐。
   *
   * 补齐不是礼貌，是硬要求：留下没有 tool 消息应答的 `tool_call_id`，会让下一个 Run
   * 带着一段非法历史去请求，厂商直接拒绝。
   */
  private failAfterToolFailure(run: ActiveRun, reason: string): RunSnapshot {
    const skippedToolCallIds = run.pendingToolCallIds.splice(0)
    skippedToolCallIds.forEach(toolCallId => {
      this.historyStore.appendToolResult(toolCallId, this.skippedAfterFailureResult)
    })
    return this.fail(run, { kind: 'tool_failure', message: reason })
  }

  private finish(
    run: ActiveRun,
    status: Extract<RunStatus, 'completed' | 'failed' | 'cancelled'>,
    reason?: string
  ): RunSnapshot {
    if (this.active !== run) return this.toSnapshot(run)
    if (!terminalStatuses.includes(run.status)) this.traces.finish(run.runId, status, reason)
    if (!terminalStatuses.includes(run.status)) {
      const event: RunEvent = status === 'completed'
        ? { type: 'COMPLETE' }
        : status === 'failed'
          ? { type: 'FAIL' }
          : { type: 'CANCEL' }
      this.transitionRun(run, event, false)
    }
    if (status === 'completed') {
      this.previousModuleIds = [...run.previousModuleIds]
    }
    this.confirmations.clear()
    this.publishState(run)
    return this.toSnapshot(run)
  }

  private requireAwaitingRun(): ActiveRun {
    const run = this.active
    if (!run || run.status !== 'awaiting_confirmation') {
      throw new Error('当前没有待确认操作')
    }
    return run
  }

  private publishConfirmation(run: ActiveRun, confirmation: ConfirmationRequest): void {
    if (this.active !== run) return
    this.beginAwaiting(run)
    this.publishState(run)
    this.dependencies.emit({ type: 'confirmation', confirmation })
  }

  /** 开始计量人工确认的等待时长，见 {@link activeElapsed}。 */
  private beginAwaiting(run: ActiveRun): void {
    run.awaitingSince = this.now()
  }

  private endAwaiting(run: ActiveRun): void {
    if (run.awaitingSince === undefined) return
    run.pausedMs += Math.max(0, this.now() - run.awaitingSince)
    run.awaitingSince = undefined
  }

  /**
   * Run 的「主动处理耗时」，即总耗时减去等待人工确认的时间。
   *
   * 超时必须按这个口径算。否则用户盯着确认卡片犹豫一分钟，Run 就超时失败了——而他刚
   * 批准的那个写入可能已经发出去了，接下来他多半会重来一次。
   */
  private activeElapsed(run: ActiveRun): number {
    const paused = run.awaitingSince === undefined
      ? 0
      : Math.max(0, this.now() - run.awaitingSince)
    return this.now() - run.startedAt - run.pausedMs - paused
  }

  /**
   * 唯一允许改动 `run.status` 的地方。
   *
   * 全部走状态机，非法迁移当场抛错。`runStateMachine.spec.ts` 有一条测试直接扫描本文件
   * 源码，防止有人图省事绕过它直接赋值。
   */
  private transitionRun(run: ActiveRun, event: RunEvent, publish = true): void {
    Object.assign(run, transition(run, event))
    if (publish) this.publishState(run)
  }

  private publishState(run: ActiveRun): void {
    if (this.active !== run) return
    const snapshot = this.toSnapshot(run)
    this.dependencies.emit({
      type: 'state',
      snapshot,
      activeModuleIds: [...run.previousModuleIds]
    })
  }

  private toSnapshot(run: ActiveRun): RunSnapshot {
    const snapshot = { runId: run.runId, traceId: run.traceId, status: run.status }
    if (this.active === run) this.lastSnapshot = snapshot
    return { ...snapshot }
  }
}
