import { describe, expect, it } from 'vitest'
import { createMaskAttribution, createStaticAttribution } from './attribution'

/** 可控时钟，避免依赖真实时间导致测试不稳定。 */
function createClock() {
  let value = 0
  return { now: () => value, advance: (ms: number) => { value += ms } }
}

describe('createMaskAttribution', () => {
  it('遮罩武装时判为 Agent 发起', () => {
    const attribution = createMaskAttribution({ isMaskArmed: () => true })

    expect(attribution.isAgentActive()).toBe(true)
  })

  it('遮罩从未武装过时判为用户发起', () => {
    const attribution = createMaskAttribution({ isMaskArmed: () => false })

    expect(attribution.isAgentActive()).toBe(false)
  })

  it('解除后的宽限期内仍算 Agent——防抖保存等延迟请求要兜住', () => {
    // Agent 的操作常触发防抖保存一类的延迟请求，它们在遮罩解除之后才真正发出。
    // 不留宽限期，这些写入会被当成用户自己的操作直接放行。
    const clock = createClock()
    let armed = true
    const attribution = createMaskAttribution({
      isMaskArmed: () => armed,
      graceMs: 500,
      now: clock.now
    })

    expect(attribution.isAgentActive()).toBe(true)
    armed = false
    clock.advance(300)

    expect(attribution.isAgentActive()).toBe(true)
  })

  it('宽限期过后回到用户发起', () => {
    const clock = createClock()
    let armed = true
    const attribution = createMaskAttribution({
      isMaskArmed: () => armed,
      graceMs: 500,
      now: clock.now
    })

    attribution.isAgentActive()
    armed = false
    clock.advance(600)

    expect(attribution.isAgentActive()).toBe(false)
  })

  it('宽限期边界：恰好等于 graceMs 时已过期', () => {
    const clock = createClock()
    let armed = true
    const attribution = createMaskAttribution({
      isMaskArmed: () => armed,
      graceMs: 500,
      now: clock.now
    })

    attribution.isAgentActive()
    armed = false
    clock.advance(500)

    expect(attribution.isAgentActive()).toBe(false)
  })

  it('重新武装会刷新宽限期起点', () => {
    const clock = createClock()
    let armed = true
    const attribution = createMaskAttribution({
      isMaskArmed: () => armed,
      graceMs: 500,
      now: clock.now
    })

    attribution.isAgentActive()
    armed = false
    clock.advance(400)
    armed = true
    attribution.isAgentActive()
    armed = false
    clock.advance(400)

    // 距最近一次武装才过 400ms，仍在宽限期内
    expect(attribution.isAgentActive()).toBe(true)
  })

  it('遮罩状态读取抛错时按 Agent 发起处理——归属未知要走完整闸门', () => {
    const attribution = createMaskAttribution({
      isMaskArmed: () => { throw new Error('遮罩实现挂了') }
    })

    expect(attribution.isAgentActive()).toBe(true)
  })
})

describe('接真实的 InteractionMask', () => {
  /**
   * 归属判定的整条依据就建立在遮罩上：遮罩武装期间用户点不动页面，因此窗口内的
   * 请求必然来自 Agent。这条用例把 `@toolairlock/ui` 的真实实现接进来，确认
   * `armed` 属性与本包的假设一致——只测自己造的假遮罩，等于没测这条依据。
   */
  it('遮罩 arm / disarm 驱动归属判定', async () => {
    const { InteractionMask } = await import('@toolairlock/ui')
    const mask = new InteractionMask()
    const attribution = createMaskAttribution({ isMaskArmed: () => mask.armed })

    expect(attribution.isAgentActive()).toBe(false)

    mask.arm()
    expect(attribution.isAgentActive()).toBe(true)

    mask.disarm()
    // 解除后立刻查询仍在宽限期内
    expect(attribution.isAgentActive()).toBe(true)
  })
})

describe('createStaticAttribution', () => {
  it('恒定返回给定值', () => {
    expect(createStaticAttribution(true).isAgentActive()).toBe(true)
    expect(createStaticAttribution(false).isAgentActive()).toBe(false)
  })
})
