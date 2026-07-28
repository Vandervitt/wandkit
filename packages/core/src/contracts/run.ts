/**
 * Run 所处的生命周期位置。
 *
 * 合法迁移在 `runtime/runStateMachine.ts` 中穷举；本包任何地方都不直接给 status
 * 赋值，因此非法迁移会抛错，而不是把 Run 留在界面渲染不出来的状态上。
 *
 * - `idle` —— 已创建，未启动。
 * - `resolving_tools` —— 挑选候选模块，并按权限过滤工具。
 * - `thinking` —— 等待模型返回。
 * - `executing_read` —— 执行无副作用的工具。
 * - `preparing_write` —— 构造确认卡片（此时尚未产生任何改动）。
 * - `awaiting_confirmation` —— 挂起，等待人工。这段时间不计入 Run 超时预算。
 * - `executing_write` —— 已批准的写入正在执行。这是**唯一**可能改数据的状态。
 * - `navigating` —— 正把用户带往某个工具的页面。
 * - `completed` / `failed` / `cancelled` —— 终态。
 */
export type RunStatus =
  | 'idle'
  | 'resolving_tools'
  | 'thinking'
  | 'executing_read'
  | 'preparing_write'
  | 'awaiting_confirmation'
  | 'executing_write'
  | 'navigating'
  | 'completed'
  | 'failed'
  | 'cancelled'

/** 状态机操作的最小形状。 */
export interface RunState {
  status: RunStatus
}

/** Run 的不可变视图，每次状态迁移都会发布给宿主。 */
export interface RunSnapshot extends RunState {
  runId: string
  traceId: string
}
