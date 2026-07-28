import type { TSchema } from '@sinclair/typebox'
import type { PreparedAction, ToolResult } from './result'

/**
 * 工具的危险等级。这是全包最重要的一个字段：它决定 Runtime 走哪条调度路径。
 *
 * - `read` —— 无副作用。静默执行，不需要确认。
 * - `write` —— 修改状态。挂起 Run，等待人工确认。
 * - `destructive` —— 不可逆地修改状态。闸门与 `write` 相同，单独区分是为了让
 *   宿主把确认界面做得更重，也让审计能分清「改了」和「删了」。
 * - `navigation` —— 把用户带到某处。不改数据，但会接管视口，因此与 `read` 分开记录。
 *
 * Runtime 从不推断风险。一个真会改数据却声明成 `read` 的工具会绕过确认——这正是
 * {@link WriteToolDefinition} 要把安全形态做成 `write`/`destructive` 唯一**可写出**
 * 的类型的原因。
 */
export type ToolRisk = 'read' | 'write' | 'destructive' | 'navigation'

/**
 * 工具的作用落在哪里。
 *
 * - `global` —— 纯数据往返；结果回给模型，若带 {@link ToolResult.uiEffect} 则同时
 *   投递给已挂载的页面。
 * - `page` —— 工具必须依托它的页面。Runtime 会先跳转并等待 Adapter 挂载，**之后**
 *   才执行。
 * - `hybrid` —— 每次调用由 {@link BaseToolDefinition.shouldOpenPage} 决定。典型场景：
 *   详情查询，用户说「看看」时开页，作为多步计划中的一环时保持 global。
 */
export type ExecutionMode = 'global' | 'page' | 'hybrid'

/** 工具是否仍然暴露给模型。 */
export type ToolLifecycleStatus = 'active' | 'deprecated'

/**
 * 废弃元数据。
 *
 * 废弃的工具是被隐藏而不是被删除，这样已经引用过它的会话会带着「替代工具是谁」
 * 明确失败，而不是无声无息地消失。
 */
export interface ToolLifecycle {
  status: ToolLifecycleStatus
  /**
   * 后继工具的稳定函数名，如 `user_query_v2`。
   * `status` 为 `deprecated` 时必填；注册表会校验目标存在且本身是 `active`。
   */
  replacement?: string
  /** `YYYY-MM-DD` 下线日期，由 {@link isValidToolSunsetDate} 校验。 */
  sunsetAt?: string
}

/**
 * 每次调用传给工具的上下文。
 *
 * 除 {@link activateModules} 外，对工具而言都是只读的。
 */
export interface ToolExecutionContext {
  /** Run 标识；在该 Run 的所有轮次与工具调用间保持稳定。 */
  runId: string
  /** 链路追踪 / 审计用的关联 ID。当前版本与 `runId` 一一对应。 */
  traceId: string
  /**
   * 用户停止或 Run 超时时被 abort。
   *
   * 做网络 I/O 的工具**必须**把它透传给 `fetch`。否则被停止的 Run 会留下在途的
   * 写请求，Runtime 只能把结果报成「未知」。
   */
  signal?: AbortSignal
  /** 用户当前所在路由（宿主暴露了路由能力时）。 */
  currentRouteName?: string
  /** 触发本次 Run 的原始用户输入。用于日志。 */
  userInput?: string
  /** 已挂载 {@link PageAdapter} 提供的结构化页面快照。 */
  pageContext?: unknown
  /** 宿主报告的当前用户权限串。 */
  permissions: string[]
  /**
   * 请求 Runtime 在后续轮次继续保留这些模块，即使用户下一句话没提到它们。
   *
   * 适用于工具发现后续工作属于另一个模块的场景（例如客户查询之后八成要用话单模块）。
   */
  activateModules(moduleIds: string[]): void
}

/** 所有工具共有的字段，与风险等级无关。 */
interface BaseToolDefinition<TInput> {
  /** 所属模块 ID。必须能在已注册的 {@link ModuleDefinition} 中找到。 */
  moduleId: string
  /** 模块内唯一的短名，如 `query`。 */
  name: string
  /**
   * 正整数。它是暴露给模型的稳定函数名的一部分，因此「参数破坏性变更」靠 bump
   * 版本号发布，不会让引用了旧形态的会话失效。
   */
  version: number
  /** 该工具的负责人或团队。由契约测试强制要求。 */
  owner?: string
  /** 废弃状态。由契约测试强制要求，见 {@link ToolLifecycle}。 */
  lifecycle?: ToolLifecycle
  /** 给界面看的可读标签。不发给模型。 */
  title: string
  /**
   * 原样发给模型——这是它挑选工具时真正推理的依据，比工具名更重要。
   * 要写「**什么时候**该用它」，而不只是「它做什么」。
   */
  description: string
  /** 本地候选解析用的关键词，在调用模型之前生效。 */
  aliases: string[]
  /**
   * 暴露该工具所需的权限。用户没有权限的工具根本不会出现在模型看到的清单里，
   * 因此模型连提议的机会都没有。必须是所属模块权限的子集。
   */
  permissions?: string[]
  executionMode: ExecutionMode
  /**
   * 参数的 TypeBox Schema。
   *
   * 必须设置 `additionalProperties: false`——由契约测试强制。否则模型幻觉出来的
   * 多余字段会通过校验并一路抵达执行器。
   */
  schema: TSchema
  /** `hybrid` 必填：逐次决定是否打开模块页面。 */
  shouldOpenPage?(input: TInput): boolean
}

/** 无副作用的工具。立即执行，结果回喂给模型。 */
export interface ReadToolDefinition<TInput = unknown, TOutput = unknown>
  extends BaseToolDefinition<TInput> {
  risk: 'read'
  execute(ctx: ToolExecutionContext, input: TInput): Promise<ToolResult<TOutput>>
}

/**
 * 会修改状态的工具，拆成被类型系统隔开的两个阶段。
 *
 * 这个拆分是全包的核心安全性质：
 *
 * 1. {@link prepare} 接收模型给的参数，**只**产出确认卡片的内容，不得改动任何东西。
 * 2. {@link execute} 接收 prepare 产出的 payload——**而不是**原始 input——并且只有
 *    在人类批准了那张卡片之后才可能被调到。
 *
 * 因为 `execute` 根本看不到 `TInput`，所以「直接拿模型输出去提交」这种工具写不出来。
 * 漏掉确认会变成一个类型错误，而不是一次生产事故。
 *
 * Runtime 还会在确认时**重跑一次** `prepare`，若结果与用户批准过的内容不一致就拒绝
 * 执行，从而堵住卡片停留在屏幕上那段时间的 TOCTOU 窗口。
 *
 * @example
 * defineWriteTool({
 *   risk: 'destructive',
 *   // ...
 *   prepare: async (ctx, input) => ({
 *     title: 'Delete user',
 *     rows: [{ label: 'User', value: await nameOf(input.id) }],
 *     impact: 'Cannot be undone',
 *     payload: { id: input.id }
 *   }),
 *   execute: async (ctx, prepared) => {
 *     await api.deleteUser(prepared.id)
 *     return { ok: true, message: 'Deleted', writeState: 'committed' }
 *   }
 * })
 */
export interface WriteToolDefinition<TInput = unknown, TPrepared = unknown, TOutput = unknown>
  extends BaseToolDefinition<TInput> {
  risk: 'write' | 'destructive'
  /**
   * 构造确认卡片。必须无副作用，且可安全多次调用——用户确认时 Runtime 会再调一次。
   *
   * 抛 {@link ToolPreparationError} 可用自定义文案让本次调用失败；抛
   * {@link ToolPreparationNotice} 则表示成功但无需确认（例如「没有需要更新的内容」）。
   */
  prepare(ctx: ToolExecutionContext, input: TInput): Promise<PreparedAction<TPrepared>>
  /**
   * 执行写入。只有在人工批准后才会走到。
   *
   * 一旦写入落库就立刻把 {@link ToolResult.writeState} 置为 `'committed'`，这样之后
   * 才到达的 abort 会被报成「已提交」而不是「未知」。
   */
  execute(ctx: ToolExecutionContext, prepared: TPrepared): Promise<ToolResult<TOutput>>
}

/**
 * 唯一作用是把用户带到某个页面的工具。
 *
 * 被钉死在 `executionMode: 'page'`——没有目标页面的导航毫无意义，直接用类型排除。
 */
export interface NavigationToolDefinition<TInput = unknown>
  extends BaseToolDefinition<TInput> {
  risk: 'navigation'
  executionMode: 'page'
  execute(ctx: ToolExecutionContext, input: TInput): Promise<ToolResult>
}

/**
 * 任意可注册工具。
 *
 * 这里的 `any` 是刻意的：注册表和调度器存的就是这个联合类型，其内容天然是异构的。
 * 作者通过 {@link defineReadTool} 等辅助函数依然能拿到完整的类型推导。
 */
export type ToolDefinition =
  | ReadToolDefinition<any, any>
  | WriteToolDefinition<any, any, any>
  | NavigationToolDefinition<any>

/**
 * 恒等函数，把对象钉到 {@link ReadToolDefinition} 上，同时保留 `execute` 的
 * 字面量输入 / 输出类型。
 *
 * 不经过它的话，对象字面量会被拓宽，`execute` 里的 `input` 会退化成 `unknown`。
 */
export const defineReadTool = <T extends ReadToolDefinition<any, any>>(tool: T): T => tool

/** 见 {@link defineReadTool}。另外强制 prepare / execute 的两阶段拆分。 */
export const defineWriteTool = <T extends WriteToolDefinition<any, any, any>>(tool: T): T => tool

/** 见 {@link defineReadTool}。 */
export const defineNavigationTool = <T extends NavigationToolDefinition<any>>(tool: T): T => tool

/**
 * 构造模型看到的稳定标识，如 `user_query_v1`。
 *
 * 把模块和版本编进名字里，一来让模型的选择在跨模块时不歧义，二来让 bump `version`
 * 就能退役旧契约，不必做一连串重命名。注册表会拒绝重名。
 */
export function buildToolFunctionName(moduleId: string, name: string, version: number): string {
  return moduleId + '_' + name + '_v' + version
}
