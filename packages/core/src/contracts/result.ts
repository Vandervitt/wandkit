/**
 * 确认卡片上的一条带标签的事实。
 *
 * 这些行是人类在批准写操作前真正会读的内容，因此必须用业务语言写清**目标**和
 * **影响**（"客户：Acme 有限公司"），绝不能只给用户无从核对的原始 ID。
 */
export interface ConfirmationRow {
  label: string
  value: string
}

/**
 * 即将发出的真实请求，展示在确认卡片上。
 *
 * 这是卡片上唯一不可能撒谎的部分：`title` / `rows` 那几行由映射逻辑或模型产出，
 * 都可能过时或写错，而 method + url + body 就是用户点下确认后要打到后端的东西本身。
 *
 * 与 `@toolairlock/ui` 的 `ConfirmCardRawRequest` 同形，可直接透传给确认卡片。
 */
export interface ConfirmationRawRequest {
  method: string
  url: string
  body?: unknown
}

/**
 * 工具随结果一起发给已挂载页面的指令。
 *
 * Runtime 只把它当作不透明信封做路由；`type` 词表和 payload 形状都由接收方
 * {@link PageAdapter} 定义，并且应当在应用前自行校验 `payload`。
 */
export interface UiEffect {
  type: string
  payload?: unknown
}

/** 单次工具调用的结果。 */
export interface ToolResult<T = unknown> {
  /** 工具是否达成了被要求做的事。 */
  ok: boolean
  /** 给用户看的一句话。仅用于展示——绝不要基于这个字符串做分支。 */
  message: string
  /** 回喂给模型的结构化数据。要小——它是要花 token 的。 */
  data?: T
  /** 给已挂载页面的可选指令，见 {@link UiEffect}。 */
  uiEffect?: UiEffect
  /**
   * 写入的持久化状态（在可知的前提下）。
   *
   * - `'committed'` —— 改动已经落库。一旦为真就立刻设置，哪怕后续步骤失败：正是
   *   它拦住了 Runtime 去劝用户重试一个其实已经生效的操作。
   * - `'unknown'` —— 请求发出去了但结果无法观测（执行中被中止、传输层抛错）。
   *   必须告诉用户不要重试。
   *
   * 读操作留空。
   */
  writeState?: 'committed' | 'unknown'
  /**
   * 这次没做成，是因为**还缺用户没给的信息**，不是操作出错了。
   *
   * 打上它，Runtime 就不会终止 Run，而是把结果回喂给模型，让模型把缺什么讲清楚、
   * 向用户追问，对话继续往下走。
   *
   * 区分这两者很重要：「少填了几个字段」和「目标不存在」在代码里都是 `ok: false`，
   * 但对用户是完全不同的两件事。一律按失败处理，会把本可以追问一句就完成的操作，
   * 变成一句「处理失败，请稍后重试」的死胡同——既不准确，也白白浪费了对话式界面
   * 最大的长处：它本来就能开口问。
   *
   * 同 {@link cancelled}，用标记判定而非比对 message 文本。
   *
   * @example
   * throw new ToolPreparationError({
   *   ok: false,
   *   message: '缺少必填项：计费类型、并发量。',
   *   needsUserInput: true
   * })
   */
  needsUserInput?: true
  /**
   * 该结果由用户取消或停止产生。
   *
   * 必须用这个标记判定取消，绝不要比对 {@link message}。message 是可本地化、可被
   * 宿主覆盖的展示文案，而「是否取消」参与控制流——取消不算工具失败，不能触发那条
   * 会中止整个 Run 的快速失败路径。两者一旦耦合，翻译一句话就会静默改变执行语义。
   */
  cancelled?: true
}

/**
 * 构造一个取消结果。
 *
 * @param message 展示文案，缺省用内置英文串。请传 `messages.cancelled` 以尊重
 *   宿主的覆盖配置。
 */
export function cancelledResult(message = 'Cancelled by user.'): ToolResult {
  return { ok: false, message, cancelled: true }
}

/** 判断一个结果是「用户取消」而非「失败」。 */
export function isCancelledResult(result: ToolResult): boolean {
  return !result.ok && result.cancelled === true
}

/**
 * 渲染确认卡片所需的全部内容，外加用户批准后要交给 `execute` 的 payload。
 *
 * Runtime 会在首次准备与确认时的重跑之间比对 `title`、`rows`、`impact` 与
 * `rawRequest`——但刻意**不比** `payload`。这场比对针对的是「人类看到并同意了什么」；
 * 一个没有改变展示语义的内部 payload 细节，不应该让用户的同意作废。
 */
export interface PreparedAction<TPayload = unknown> {
  /** 卡片标题，如 "Delete user"。 */
  title: string
  /** 用户正在批准的那些事实，见 {@link ConfirmationRow}。 */
  rows: ConfirmationRow[]
  /** 透传给 `execute` 的不透明数据。永不展示给用户。 */
  payload: TPayload
  /** 可选的后果说明，如 "Cannot be undone"。 */
  impact?: string
  /**
   * 可选的原始请求，见 {@link ConfirmationRawRequest}。
   *
   * 与 `title` / `rows` / `impact` 一样参与确认时的重跑比对——它是展示给用户的内容，
   * 而且是其中最不该被偷换的那部分。
   */
  rawRequest?: ConfirmationRawRequest
}

/**
 * 从 `prepare` 抛出，用一个具体结果让本次工具调用失败。
 *
 * 适用于准备阶段就判定操作无法进行的情况（目标不存在、前置条件不满足）。Run 会带着
 * 这个结果失败，而不是一个笼统的错误。
 */
export class ToolPreparationError extends Error {
  constructor(public readonly result: ToolResult) {
    super(result.message)
    this.name = 'ToolPreparationError'
  }
}

/**
 * 从 `prepare` 抛出，表示**成功**结束且无需确认。
 *
 * 适用于确实没有东西可写的情况（例如目标值本来就是这个）。让人去批准一个空操作，
 * 只会训练他们无脑点确认——而那恰恰是本包存在的意义所反对的。
 */
export class ToolPreparationNotice extends Error {
  constructor(public readonly result: ToolResult & { ok: true }) {
    super(result.message)
    this.name = 'ToolPreparationNotice'
  }
}
