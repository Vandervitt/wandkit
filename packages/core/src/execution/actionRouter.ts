import { resolveMessages, type WandkitMessages } from '../config/messages'
import type { DeadlineScope, RunDeadlinePhase } from '../contracts/deadline'
import type { PageAdapter } from '../contracts/pageAdapter'
import { cancelledResult, type PreparedAction, type ToolResult, type UiEffect } from '../contracts/result'
import type { ToolDefinition, ToolExecutionContext } from '../contracts/tool'
import type { NavigationCoordinator } from './navigationCoordinator'
import { PageWaitTimeoutError, type PageAdapterRegistry } from './pageAdapterRegistry'

export interface ActionRouterDependencies {
  adapters: PageAdapterRegistry
  navigation: NavigationCoordinator
  /** 把模块 ID 解析为它的规范路由名（通常取 `module.routes[0]`）。 */
  resolveRouteName(moduleId: string): string | undefined
  /** 覆盖面向用户的话术；缺省用内置英文。 */
  messages?: Partial<WandkitMessages>
}

export interface ExecuteActionOptions {
  tool: ToolDefinition
  context: ToolExecutionContext
  /** 模型给出的参数。写工具走 `prepared`，此字段被忽略。 */
  input: unknown
  /** 写工具必填：用户已批准并经过重跑校验的 prepare 产物。 */
  prepared?: PreparedAction
  /** 本次动作的页面同步请求 ID，用于仲裁新旧请求。 */
  requestId: string
  /** Runtime 级共享 Deadline；直接使用 ActionRouter 的宿主可省略。 */
  deadline?: DeadlineScope
}

/** 一次进行中的页面同步请求的定位信息。 */
interface PageSyncRequest {
  moduleId: string
  routeName: string
  requestId: string
}

/**
 * 把一次工具调用落到「执行 + 页面同步」上。
 *
 * 这是全包最绕的一段，绕的根源只有一个：**每一次 await 之间，世界都可能变了**。
 * 用户可能按了停止，也可能发起了一个更新的请求接管同一个页面。因此下面每个跨越
 * await 的分支都要重新回答两个问题：
 *
 * 1. `signal.aborted` —— 用户还想要这个结果吗？
 * 2. `isLatestPageSync` —— 这个页面还归本请求管吗？
 *
 * 两者的处理方式刻意不同：**中止**必须区分读和写（读可以干脆报取消，写在结果未知
 * 时必须明确告诉用户别重复提交）；而**被取代**在任何情况下都只是丢弃结果，因为接管
 * 的那个请求才是用户当下要的。
 *
 * 还有一条贯穿始终的次序原则：先执行工具、再应用 UI 效果。工具失败时页面同步一律
 * 标记为 failed，让页面回退到自己加载，绝不留白屏。
 */
export class ActionRouter {
  private readonly dependencies: ActionRouterDependencies
  private readonly messages: WandkitMessages

  constructor(dependencies: ActionRouterDependencies) {
    this.dependencies = dependencies
    this.messages = resolveMessages(dependencies.messages)
  }

  /**
   * 执行一次工具调用，并按需完成页面跳转与结果注入。
   *
   * 三条主路径：
   * - `page` 模式：先跳转并等页面挂载，再执行（页面必须在场才有意义）。
   * - `hybrid` 且 `shouldOpenPage` 为真：同上。
   * - 其余：先执行；若结果带 uiEffect，再决定投递给已挂载页面还是先跳转。
   *
   * 无论哪条路径，只要开启了页面同步，就必须在这里先 `beginRequest` 占坑——这样在
   * 跳转和执行期间到来的更新请求，才能把本请求判为过期。
   */
  async execute(options: ExecuteActionOptions): Promise<ToolResult> {
    if (options.context.signal?.aborted) return this.cancelledResult()
    const shouldSyncPage = options.tool.executionMode === 'page' ||
      (options.tool.executionMode === 'hybrid' && options.tool.shouldOpenPage?.(options.input))
    let pageSync: PageSyncRequest | undefined
    if (shouldSyncPage) {
      const routeName = this.dependencies.resolveRouteName(options.tool.moduleId)
      if (!routeName) return this.missingPageResult()
      pageSync = {
        moduleId: options.tool.moduleId,
        routeName,
        requestId: options.requestId
      }
      if (this.dependencies.adapters.get(pageSync.moduleId, pageSync.routeName)) {
        this.dependencies.adapters.beginRequest(
          pageSync.moduleId,
          pageSync.routeName,
          pageSync.requestId
        )
      } else {
        this.dependencies.adapters.beginRequestAwaitingPageObserver(
          pageSync.moduleId,
          pageSync.routeName,
          pageSync.requestId
        )
      }
    }
    if (options.tool.executionMode === 'page') {
      return this.executeOnPage(options, pageSync as PageSyncRequest)
    }

    let result: ToolResult
    try {
      result = await this.executeToolWithAbortSemantics(options)
    } catch (error) {
      this.failPageSync(pageSync)
      throw error
    }
    if (options.context.signal?.aborted) {
      this.invalidatePageSync(pageSync)
      return result
    }
    if (!this.isLatestPageSync(pageSync)) return this.expiredPageSyncResult()
    if (!result.ok || !result.uiEffect) {
      this.failPageSync(pageSync)
      return result
    }

    const routeName = pageSync?.routeName ??
      this.dependencies.resolveRouteName(options.tool.moduleId)
    if (!routeName) {
      if (
        options.tool.executionMode === 'hybrid' &&
        options.tool.shouldOpenPage?.(options.input)
      ) return this.missingPageResult()
      return result
    }

    const mounted = this.dependencies.adapters.get(options.tool.moduleId, routeName)
    if (mounted) {
      if (!this.isLatestPageSync(pageSync)) return this.expiredPageSyncResult()
      return this.applyEffectWithAbortSemantics(options, result, mounted, pageSync)
    }

    if (pageSync) {
      return this.navigateAndApply(options, pageSync, result)
    }

    return result
  }

  /** `page` 模式：页面必须先在场，再执行工具。 */
  private async executeOnPage(
    options: ExecuteActionOptions,
    pageSync: PageSyncRequest
  ): Promise<ToolResult> {
    let adapter: PageAdapter
    try {
      if (!this.isLatestPageSync(pageSync)) return this.expiredPageSyncResult()
      adapter = await this.dependencies.navigation.navigateAndWait(
        pageSync.moduleId,
        pageSync.routeName,
        options.requestId,
        {
          signal: options.context.signal,
          deadline: options.deadline
        }
      )
    } catch (error) {
      if (options.context.signal?.aborted) {
        this.invalidatePageSync(pageSync)
        return this.cancelledResult()
      }
      if (!this.isLatestPageSync(pageSync)) return this.expiredPageSyncResult()
      this.failPageSync(pageSync)
      return this.navigationFailure(error)
    }

    if (options.context.signal?.aborted) {
      this.invalidatePageSync(pageSync)
      return this.cancelledResult()
    }
    if (!this.isLatestPageSync(pageSync)) return this.expiredPageSyncResult()

    let result: ToolResult
    try {
      result = await this.executeToolWithAbortSemantics(options)
    } catch (error) {
      this.failPageSync(pageSync)
      throw error
    }
    if (options.context.signal?.aborted) {
      this.invalidatePageSync(pageSync)
      return result
    }
    if (!this.isLatestPageSync(pageSync)) return this.expiredPageSyncResult()
    if (!result.ok || !result.uiEffect) {
      this.failPageSync(pageSync)
      return result
    }
    return this.applyEffectWithAbortSemantics(options, result, adapter, pageSync)
  }

  /** 工具已执行完但页面尚未挂载：跳过去，然后把结果投递给它。 */
  private async navigateAndApply(
    options: ExecuteActionOptions,
    pageSync: PageSyncRequest,
    result: ToolResult
  ): Promise<ToolResult> {
    try {
      if (!this.isLatestPageSync(pageSync)) return this.expiredPageSyncResult()
      const adapter = await this.dependencies.navigation.navigateAndWait(
        pageSync.moduleId,
        pageSync.routeName,
        options.requestId,
        {
          signal: options.context.signal,
          deadline: options.deadline
        }
      )
      if (options.context.signal?.aborted) {
        this.invalidatePageSync(pageSync)
        return this.resultAfterAbort(options, result)
      }
      if (!this.isLatestPageSync(pageSync)) return this.expiredPageSyncResult()
      return this.applyEffectWithAbortSemantics(options, result, adapter, pageSync)
    } catch (error) {
      if (options.context.signal?.aborted) {
        this.invalidatePageSync(pageSync)
        return this.resultAfterAbort(options, result)
      }
      if (!this.isLatestPageSync(pageSync)) return this.expiredPageSyncResult()
      this.failPageSync(pageSync)
      return this.navigationFailure(error)
    }
  }

  /**
   * 调用工具本体。
   *
   * 写工具在这里只接受 `prepared.payload`，绝不接触 `input`——这是 prepare/execute
   * 两阶段在运行时的最后一道落实。缺 `prepared` 说明调用方绕过了确认流程，属于编码
   * 错误，直接失败而不是放行。
   */
  private async executeTool(options: ExecuteActionOptions): Promise<ToolResult> {
    if (options.tool.risk === 'write' || options.tool.risk === 'destructive') {
      if (!options.prepared) {
        return { ok: false, message: this.messages.writeNotPrepared }
      }
      return options.tool.execute(options.context, options.prepared.payload)
    }

    return options.tool.execute(options.context, options.input)
  }

  /**
   * 在中止语义下执行工具。
   *
   * 中止时读写分道：读直接报取消；写则必须走 {@link unknownWriteResult}——请求可能
   * 已经打到后端并生效了，此时说「失败」会诱导用户重复提交。
   */
  private async executeToolWithAbortSemantics(
    options: ExecuteActionOptions
  ): Promise<ToolResult> {
    try {
      const result = await this.runWithDeadline(
        options,
        this.executionPhase(options),
        () => this.executeTool(options)
      )
      return options.context.signal?.aborted
        ? this.resultAfterAbort(options, result)
        : result
    } catch (error) {
      if (options.context.signal?.aborted) {
        return this.isWrite(options)
          ? this.unknownWriteResult()
          : this.cancelledResult()
      }
      throw error
    }
  }

  /**
   * 中止发生后如何解释已经拿到的结果。
   *
   * 只有工具明确说了 `ok` 或 `writeState === 'committed'`，才认可这次写入；否则一律
   * 降级为「结果未知」。宁可让用户去刷新核对，也不能让他误以为没生效而再点一次。
   */
  private resultAfterAbort(
    options: ExecuteActionOptions,
    result: ToolResult
  ): ToolResult {
    if (!this.isWrite(options)) return this.cancelledResult()
    return result.ok || result.writeState === 'committed'
      ? result
      : this.unknownWriteResult()
  }

  private isWrite(options: ExecuteActionOptions): boolean {
    return options.tool.risk === 'write' || options.tool.risk === 'destructive'
  }

  private executionPhase(options: ExecuteActionOptions): RunDeadlinePhase {
    if (this.isWrite(options)) return 'write_execution'
    return options.tool.risk === 'navigation'
      ? 'navigation_execution'
      : 'read_execution'
  }

  private runWithDeadline<T>(
    options: ExecuteActionOptions,
    phase: RunDeadlinePhase,
    operation: () => T | Promise<T>
  ): Promise<T> {
    if (options.deadline) return options.deadline.run(phase, operation)
    try {
      return Promise.resolve(operation())
    } catch (error) {
      return Promise.reject(error)
    }
  }

  /** 把 uiEffect 投递给页面，成功后把该页面同步请求标记为 completed。 */
  private async applyEffect(
    options: ExecuteActionOptions,
    result: ToolResult,
    adapter: PageAdapter,
    pageSync?: PageSyncRequest
  ): Promise<ToolResult> {
    await this.runWithDeadline(options, 'ui_effect', () => (
      options.context.signal
        ? adapter.applyUiEffect(
          result.uiEffect as UiEffect,
          options.requestId,
          options.context.signal
        )
        : adapter.applyUiEffect(result.uiEffect as UiEffect, options.requestId)
    ))
    if (pageSync) {
      this.dependencies.adapters.completeRequest(
        pageSync.moduleId,
        pageSync.routeName,
        pageSync.requestId
      )
    }
    return result
  }

  /**
   * 在中止与过期语义下投递 uiEffect。
   *
   * 投递前再查一次是否仍是最新请求：从工具执行结束到这里之间又隔了若干个 await。
   */
  private async applyEffectWithAbortSemantics(
    options: ExecuteActionOptions,
    result: ToolResult,
    adapter: PageAdapter,
    pageSync?: PageSyncRequest
  ): Promise<ToolResult> {
    try {
      if (!this.isLatestPageSync(pageSync)) return this.expiredPageSyncResult()
      return await this.applyEffect(options, result, adapter, pageSync)
    } catch (error) {
      if (options.context.signal?.aborted) {
        this.invalidatePageSync(pageSync)
        return this.resultAfterAbort(options, result)
      }
      this.failPageSync(pageSync)
      return this.effectFailure(error, result)
    }
  }

  /** 未开启页面同步时恒为真，避免调用点写一堆 `pageSync ? ... : true`。 */
  private isLatestPageSync(pageSync?: PageSyncRequest): boolean {
    return !pageSync || this.dependencies.adapters.isLatestRequest(
      pageSync.moduleId,
      pageSync.routeName,
      pageSync.requestId
    )
  }

  private invalidatePageSync(pageSync?: PageSyncRequest): void {
    if (!pageSync) return
    this.dependencies.adapters.invalidateRequest(
      pageSync.moduleId,
      pageSync.routeName,
      pageSync.requestId
    )
  }

  private failPageSync(pageSync?: PageSyncRequest): void {
    if (!pageSync) return
    this.dependencies.adapters.failRequest(
      pageSync.moduleId,
      pageSync.routeName,
      pageSync.requestId
    )
  }

  private expiredPageSyncResult(): ToolResult {
    return { ok: false, message: this.messages.pageSyncExpired }
  }

  /**
   * 区分「写入已提交但刷新失败」和「页面同步失败」。
   *
   * 前者数据已经改了，文案必须劝阻重试并保留 `writeState: 'committed'`；后者写入并未
   * 发生，按普通失败处理即可。把这两种混为一谈，就是重复扣款一类事故的来源。
   */
  private effectFailure(_error: unknown, result: ToolResult): ToolResult {
    if (result.writeState === 'committed') {
      return {
        ok: false,
        message: this.messages.writeCommittedRefreshFailed,
        writeState: 'committed'
      }
    }
    return {
      ok: false,
      message: this.messages.pageSyncFailed
    }
  }

  /**
   * 区分「页面始终没挂载」与「路由器拒绝了跳转」。
   *
   * 靠错误类型判定，绝不靠 message 文本：message 是可本地化、可被宿主覆盖的，一次翻译
   * 就会把所有超时静默地甩进通用的跳转失败分支。
   */
  private navigationFailure(error: unknown): ToolResult {
    if (error instanceof PageWaitTimeoutError) {
      return { ok: false, message: this.messages.navigationTimeout }
    }
    return { ok: false, message: this.messages.navigationFailed }
  }

  private missingPageResult(): ToolResult {
    return { ok: false, message: this.messages.missingPage }
  }

  private cancelledResult(): ToolResult {
    return cancelledResult(this.messages.cancelled)
  }

  private unknownWriteResult(): ToolResult {
    return {
      ok: false,
      message: this.messages.writeStateUnknown,
      writeState: 'unknown'
    }
  }
}
