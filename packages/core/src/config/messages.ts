/**
 * Runtime 输出给最终用户的文案。
 *
 * 每一条都可被宿主覆盖：不同产品的语气、语言，尤其是「出事之后要让用户做什么」
 * 的表述差异极大。写入态那几条更是事故现场的第一句话，必须让宿主自己掌握措辞。
 *
 * 这些字符串**不承载任何控制语义**。绝不要基于文案分支：判断是否取消请读
 * {@link ToolResult.cancelled}。一旦把文案和控制流耦合，翻译一句话就会静默
 * 改变执行行为。
 */
export interface WandkitMessages {
  /** 用户主动取消 Run，或明确拒绝了某次确认。 */
  cancelled: string

  // ── 工具调用参数 ────────────────────────────────────────────────────
  /** 模型返回的 arguments 不是可解析的 JSON。 */
  invalidJson: string
  /**
   * 参数未通过 JSON Schema 校验。
   *
   * 刻意做成笼统表述：Ajv 原始的 errorsText 会带出 `data.companyId` 这类内部
   * 字段路径，对用户既不可读又有轻微泄漏。
   */
  invalidInput: string
  /** 工具的 execute / prepare 抛出了异常。 */
  executionFailure: string

  // ── Run 调度 ────────────────────────────────────────────────────────
  /** 同一个 tool_call_id 出现了两次——重放或畸形响应。 */
  duplicateToolCall: string
  /** 本轮前序工具已失败，本次调用未执行。 */
  skippedAfterFailure: string
  /** 正在让模型修正参数，本次调用被跳过。 */
  skippedForModelCorrection: string
  /** 待确认的工具在等待期间被注销或降级了。 */
  staleConfirmationTool: string
  /**
   * 确认后重跑 prepare，产出的内容与用户批准过的不一致。
   * 此时拒绝执行，而不是把写入落到已经移位的目标上。
   */
  confirmationContentChanged: string

  // ── 页面协同 ────────────────────────────────────────────────────────
  /** 写操作没走 prepare 就到了 execute——属于编码错误。 */
  writeNotPrepared: string
  /** 更新的页面同步请求已接管，本请求结果作废。 */
  pageSyncExpired: string
  /** UI 效果应用失败，且写入**未**提交。 */
  pageSyncFailed: string
  /**
   * 写入已提交，但页面刷新失败。
   *
   * 必须劝阻重试：数据已经改了，再提交一次就是重复生效。
   */
  writeCommittedRefreshFailed: string
  /**
   * 写入请求已发出但结果未知（执行中被中止，或传输层抛错）。同样必须劝阻重试。
   */
  writeStateUnknown: string
  /** 目标页面在超时前没有挂载出匹配的 Adapter。 */
  navigationTimeout: string
  /** 路由跳转本身被拒绝。 */
  navigationFailed: string
  /** 工具所属模块没有声明路由，无法做页面同步。 */
  missingPage: string

  // ── 预算与限额 ──────────────────────────────────────────────────────
  /** 达到最大模型轮次。`{limit}` 会被插值。 */
  maxRoundsReached: string
  /** 达到最大工具调用数。`{limit}` 会被插值。 */
  maxToolCallsReached: string
  /** Run 超出墙钟预算。`{ms}` 会被插值。 */
  runTimeout: string
  /** Run 的兜底失败。 */
  runFailed: string
  /** 用户点了停止。 */
  stoppedByUser: string
  /**
   * 模型调用了当前未暴露的工具。这条会回喂给模型让它自我纠正。
   * `{name}` 与 `{available}` 会被插值。
   */
  toolUnavailable: string
  /** 一个工具都没暴露时，`{available}` 的占位文本。 */
  noToolAvailable: string
}

/**
 * 内置英文文案。
 *
 * 覆盖时值得沿用的几条措辞原则：
 * - 写入结果未知时不要说 "failed"，要说结果未知；
 * - 未知态和已提交态都必须显式带上「不要重复提交」；
 * - 文案要可执行——告诉用户下一步做什么，而不是描述哪里坏了。
 */
export const defaultMessages: WandkitMessages = {
  cancelled: 'Cancelled by user.',

  invalidJson: 'The tool arguments were not valid JSON.',
  invalidInput: 'The tool arguments were rejected. Please adjust them and try again.',
  executionFailure: 'The tool failed to run. Please try again shortly.',

  duplicateToolCall: 'Duplicate tool call rejected.',
  skippedAfterFailure: 'Skipped: an earlier tool call in this round failed.',
  skippedForModelCorrection: 'Skipped: the model is correcting its arguments.',
  staleConfirmationTool: 'The pending tool is no longer available.',
  confirmationContentChanged:
    'The target or impact of this operation has changed. '
    + 'Please start over and confirm the current details.',

  writeNotPrepared: 'This write has not completed its confirmation step.',
  pageSyncExpired: 'This page sync request is no longer current.',
  pageSyncFailed: 'Could not sync the page. Please try again shortly.',
  writeCommittedRefreshFailed:
    'The change was saved, but the page could not be refreshed. '
    + 'Do not submit again — refresh the page to verify.',
  writeStateUnknown:
    'The request was sent but its outcome is unknown. '
    + 'Do not submit again — refresh the page to verify.',
  navigationTimeout: 'The page took too long to load. Please try again shortly.',
  navigationFailed: 'Could not open the page. Please try again shortly.',
  missingPage: 'No page is registered for this tool.',

  maxRoundsReached: 'Reached the maximum of {limit} model rounds.',
  maxToolCallsReached: 'Reached the maximum of {limit} tool calls.',
  runTimeout: 'The run exceeded {ms}ms.',
  runFailed: 'The run failed. Please try again shortly.',
  stoppedByUser: 'Stopped by user.',
  toolUnavailable:
    'Tool {name} is not available right now. Available tools: {available}. '
    + 'Use one of those instead.',
  noToolAvailable: '(none)'
}

/**
 * 把宿主的覆盖项合并到内置文案之上。
 *
 * 没有覆盖项时直接返回共享的 {@link defaultMessages}，让常见路径零分配。
 */
export function resolveMessages(overrides?: Partial<WandkitMessages>): WandkitMessages {
  return overrides ? { ...defaultMessages, ...overrides } : defaultMessages
}

/**
 * 最小化的 `{key}` 插值。
 *
 * 未知占位符原样保留，而不是替换成 `undefined`。这样漏配的键会在界面上显示成
 * `{limit}`，一眼就能回溯到配置错误，而不是静默渲染成空字符串。
 */
export function formatMessage(
  template: string,
  values: Record<string, string | number>
): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match)
}
