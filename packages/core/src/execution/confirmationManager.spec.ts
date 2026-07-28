import { describe, expect, it } from 'vitest'
import type { PreparedAction } from '../contracts/result'
import {
  ConfirmationManager,
  type PendingPreparedCall
} from './confirmationManager'

function pending(id: string, payload: unknown = { safe: id }): PendingPreparedCall {
  const prepared: PreparedAction = {
    title: '确认 ' + id,
    rows: [{ label: '名称', value: id }],
    payload
  }
  return {
    confirmationId: 'confirmation-' + id,
    toolCallId: 'call-' + id,
    functionName: 'gateway_update_v1',
    input: { name: id },
    prepared,
    risk: 'write'
  }
}

describe('ConfirmationManager', () => {
  it('入队后只暴露第一个确认项的安全字段', () => {
    const manager = new ConfirmationManager()
    const first = pending('one')

    expect(manager.enqueue([first, pending('two')])).toEqual({
      confirmationId: 'confirmation-one',
      toolCallId: 'call-one',
      functionName: 'gateway_update_v1',
      title: '确认 one',
      rows: [{ label: '名称', value: 'one' }],
      risk: 'write'
    })
    expect(manager.current()).toEqual(manager.advance())
    expect(manager.current()).not.toHaveProperty('prepared')
    expect(manager.current()).not.toHaveProperty('payload')
    expect(manager.current()).not.toHaveProperty('input')
  })

  it('把 prepare 声明的原始请求透传给界面', () => {
    const manager = new ConfirmationManager()
    const item = pending('raw')
    item.prepared.rawRequest = {
      method: 'delete',
      url: '/api/users/u_1',
      body: { id: 'u_1' }
    }

    expect(manager.enqueue([item])?.rawRequest).toEqual({
      method: 'delete',
      url: '/api/users/u_1',
      body: { id: 'u_1' }
    })
  })

  it('只有确认当前项后才推进到下一项', () => {
    const manager = new ConfirmationManager()
    const first = pending('one')
    const second = pending('two')
    manager.enqueue([first, second])

    expect(manager.approve('confirmation-one')).toBe(first)
    expect(manager.current()?.confirmationId).toBe('confirmation-two')
    expect(manager.approve('confirmation-two').prepared.payload).toEqual({ safe: 'two' })
    expect(manager.advance()).toBeUndefined()
  })

  it('取消返回当前 prepared 调用并推进队列', () => {
    const manager = new ConfirmationManager()
    const first = pending('one')
    manager.enqueue([first, pending('two')])

    expect(manager.reject('confirmation-one')).toBe(first)
    expect(manager.current()?.confirmationId).toBe('confirmation-two')
  })

  it('拒绝跨过队首确认或取消，clear 可回收全部待确认项', () => {
    const manager = new ConfirmationManager()
    manager.enqueue([pending('one'), pending('two')])

    expect(() => manager.approve('confirmation-two')).toThrow('Confirmation not found or no longer current')
    expect(() => manager.reject('confirmation-two')).toThrow('Confirmation not found or no longer current')

    manager.clear()
    expect(manager.current()).toBeUndefined()
  })
})
