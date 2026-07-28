import { describe, expect, it } from 'vitest'
import { cancelledResult, isCancelledResult } from './result'

describe('取消结果的判定', () => {
  it('默认话术下判定为取消', () => {
    expect(isCancelledResult(cancelledResult())).toBe(true)
  })

  it('话术被宿主本地化后，仍判定为取消', () => {
    // 回归：取消判定曾用 message 文本相等实现，一旦本地化/自定义话术
    // 就会退化成普通失败，进而误触发 failAfterToolFailure 终止整个 Run。
    expect(isCancelledResult(cancelledResult('Operation cancelled by user'))).toBe(true)
    expect(isCancelledResult(cancelledResult('操作已中止'))).toBe(true)
  })

  it('文案碰巧相同但并非取消的失败，不得被误判为取消', () => {
    expect(isCancelledResult({ ok: false, message: '用户已取消操作' })).toBe(false)
  })

  it('成功结果永远不是取消', () => {
    expect(isCancelledResult({ ok: true, message: '', cancelled: true })).toBe(false)
  })
})
