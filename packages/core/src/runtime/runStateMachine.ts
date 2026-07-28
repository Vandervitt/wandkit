import type { RunState, RunStatus } from '../contracts/run'

/**
 * 可以驱动 Run 前进的事件。
 *
 * 与 {@link RunStatus} 配套构成一张显式迁移表：Runtime 从不直接给 status 赋值，
 * 一切都过 {@link transition}。这条纪律的价值在于——非法迁移（例如没走确认就
 * `WRITE_VALIDATED`）会当场抛错，而不是把 Run 留在一个界面渲染不出来、也没人能解释的
 * 状态上。`runStateMachine.spec.ts` 里有一条测试专门扫描源码，防止有人绕开它。
 */
export type RunEvent =
  | { type: 'START' }
  | { type: 'TOOLS_RESOLVED' }
  | { type: 'EXECUTE_READ' }
  | { type: 'READ_COMPLETED' }
  | { type: 'PREPARE_WRITE' }
  | { type: 'PREPARE_COMPLETED' }
  | { type: 'AWAIT_CONFIRMATION' }
  | { type: 'CONFIRM' }
  | { type: 'WRITE_VALIDATED' }
  | { type: 'WRITE_COMPLETED' }
  | { type: 'CONFIRMATION_REJECTED' }
  | { type: 'NAVIGATE' }
  | { type: 'NAVIGATION_COMPLETED' }
  | { type: 'COMPLETE' }
  | { type: 'FAIL' }
  | { type: 'CANCEL' }
  | { type: 'ABORT' }

type RunEventType = RunEvent['type']
type TransitionTable = Partial<Record<RunStatus, Partial<Record<RunEventType, RunStatus>>>>

/**
 * 任何非终态都接受的三个终止事件。
 *
 * 提取出来展开到每个状态里，是为了保证「无论 Run 卡在哪一步，用户都能停掉它」——
 * 漏配某个状态就意味着那里会出现一个停不下来的 Run。
 */
const activityEndTransitions: Partial<Record<RunEventType, RunStatus>> = {
  FAIL: 'failed',
  CANCEL: 'cancelled',
  ABORT: 'cancelled'
}

const transitions: TransitionTable = {
  idle: {
    START: 'resolving_tools'
  },
  resolving_tools: {
    ...activityEndTransitions,
    TOOLS_RESOLVED: 'thinking'
  },
  thinking: {
    ...activityEndTransitions,
    EXECUTE_READ: 'executing_read',
    PREPARE_WRITE: 'preparing_write',
    AWAIT_CONFIRMATION: 'awaiting_confirmation',
    NAVIGATE: 'navigating',
    COMPLETE: 'completed'
  },
  executing_read: {
    ...activityEndTransitions,
    READ_COMPLETED: 'thinking'
  },
  preparing_write: {
    ...activityEndTransitions,
    PREPARE_COMPLETED: 'thinking',
    WRITE_VALIDATED: 'executing_write'
  },
  awaiting_confirmation: {
    ...activityEndTransitions,
    CONFIRM: 'preparing_write',
    CONFIRMATION_REJECTED: 'thinking'
  },
  executing_write: {
    ...activityEndTransitions,
    WRITE_COMPLETED: 'thinking'
  },
  navigating: {
    ...activityEndTransitions,
    NAVIGATION_COMPLETED: 'thinking'
  },
  completed: {
    START: 'resolving_tools'
  },
  failed: {
    START: 'resolving_tools'
  },
  cancelled: {
    START: 'resolving_tools'
  }
}

/**
 * 施加一次状态迁移。
 *
 * @returns 新状态。永远返回新对象，不改动入参。
 * @throws 当前状态不接受该事件时抛出——这属于编码错误，必须在开发期就炸出来。
 */
export function transition(state: RunState, event: RunEvent): RunState {
  const nextStatus = transitions[state.status]?.[event.type]
  if (!nextStatus) {
    throw new Error(`Illegal run state transition: ${state.status} + ${event.type}`)
  }
  return { status: nextStatus }
}
