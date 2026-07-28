import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { transition, type RunEvent } from './runStateMachine'
import type { RunStatus } from '../contracts/run'

function follow(events: RunEvent[]): RunStatus {
  return events.reduce(
    (state, event) => transition({ status: state }, event).status,
    'idle' as RunStatus
  )
}

describe('Run 状态机', () => {
  it('完成正常读工具链路', () => {
    expect(follow([
      { type: 'START' },
      { type: 'TOOLS_RESOLVED' },
      { type: 'EXECUTE_READ' },
      { type: 'READ_COMPLETED' },
      { type: 'COMPLETE' }
    ])).toBe('completed')
  })

  it('从写操作准备进入确认并在确认后执行', () => {
    expect(follow([
      { type: 'START' },
      { type: 'TOOLS_RESOLVED' },
      { type: 'PREPARE_WRITE' },
      { type: 'PREPARE_COMPLETED' },
      { type: 'AWAIT_CONFIRMATION' },
      { type: 'CONFIRM' },
      { type: 'WRITE_VALIDATED' },
      { type: 'WRITE_COMPLETED' },
      { type: 'COMPLETE' }
    ])).toBe('completed')
  })

  it('同轮可以准备多个写操作，并在取消一项后继续等待下一项确认', () => {
    expect(follow([
      { type: 'START' },
      { type: 'TOOLS_RESOLVED' },
      { type: 'PREPARE_WRITE' },
      { type: 'PREPARE_COMPLETED' },
      { type: 'PREPARE_WRITE' },
      { type: 'PREPARE_COMPLETED' },
      { type: 'AWAIT_CONFIRMATION' },
      { type: 'CONFIRMATION_REJECTED' },
      { type: 'AWAIT_CONFIRMATION' }
    ])).toBe('awaiting_confirmation')
  })

  it('完成页面导航后继续思考', () => {
    expect(follow([
      { type: 'START' },
      { type: 'TOOLS_RESOLVED' },
      { type: 'NAVIGATE' },
      { type: 'NAVIGATION_COMPLETED' }
    ])).toBe('thinking')
  })

  it.each([
    ['CANCEL', 'cancelled'],
    ['ABORT', 'cancelled'],
    ['FAIL', 'failed']
  ] as const)('%s 可以结束活动中的 Run', (type, expected) => {
    expect(follow([
      { type: 'START' },
      { type: 'TOOLS_RESOLVED' },
      { type }
    ])).toBe(expected)
  })

  it.each(['completed', 'failed', 'cancelled'] as const)(
    '允许从 %s 重新开始',
    status => {
      expect(transition({ status }, { type: 'START' }).status)
        .toBe('resolving_tools')
    }
  )

  it('拒绝非法状态迁移', () => {
    expect(() => transition({ status: 'idle' }, { type: 'CONFIRM' }))
      .toThrow('Illegal run state transition')
  })

  it('AgentRuntime 统一通过状态机迁移，不直接写入 run.status', () => {
    // 相对本文件解析，而非 process.cwd()：后者会随运行目录和仓库结构变化而失效。
    const source = readFileSync(
      fileURLToPath(new URL('./agentRuntime.ts', import.meta.url)),
      'utf8'
    )

    expect(source).toMatch(/import \{ transition(?:,| \})/)
    expect(source).toContain('transition(run,')
    expect(source).not.toMatch(/\brun\.status\s*=(?!=)/)
  })
})
