/**
 * 确认期间遮罩必须让位。
 *
 * 真实接入实测的缺陷：遮罩的 z-index 高于宿主放置聊天面板的容器，确认卡片弹出来
 * 却点不动——Run 卡在 `awaiting_confirmation`，而用户完全看不出为什么。
 *
 * 提高卡片自身的 z-index 解决不了：卡片在宿主容器的**层叠上下文内**，它的层级只在
 * 那个容器内部比较。层级由宿主决定，包内改不了。
 *
 * 正确的解法是遮罩**主动让位**——它的职责本就是挡住用户操作页面，而确认卡片恰恰
 * 需要用户点击。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { InteractionMask } from './mask'
import { createMaskReleaser, withMaskReleased } from './maskRelease'

beforeEach(() => {
  document.body.replaceChildren()
})

describe('withMaskReleased', () => {
  it('确认期间解除遮罩，结束后恢复', async () => {
    const mask = new InteractionMask()
    mask.arm()
    let armedDuring = true

    await withMaskReleased(mask, async () => {
      armedDuring = mask.armed
    })

    expect(armedDuring).toBe(false)
    expect(mask.armed).toBe(true)
  })

  it('原本未武装时事后不误开', async () => {
    // 用户自己触发的确认（非 Agent 动作期间）不该凭空出现一层遮罩。
    const mask = new InteractionMask()

    await withMaskReleased(mask, async () => undefined)

    expect(mask.armed).toBe(false)
  })

  it('抛异常时同样恢复——否则页面永久点不动', async () => {
    const mask = new InteractionMask()
    mask.arm()

    await expect(
      withMaskReleased(mask, async () => { throw new Error('确认失败') })
    ).rejects.toThrow('确认失败')

    expect(mask.armed).toBe(true)
  })

  it('原样返回被包裹函数的结果', async () => {
    const mask = new InteractionMask()
    mask.arm()

    await expect(withMaskReleased(mask, async () => 'approved')).resolves.toBe('approved')
  })

  it('遮罩为空时直接执行，便于宿主不接遮罩', async () => {
    await expect(withMaskReleased(undefined, async () => 'ok')).resolves.toBe('ok')
  })

  it('嵌套调用不会提前恢复外层', async () => {
    const mask = new InteractionMask()
    mask.arm()
    const seen: boolean[] = []

    await withMaskReleased(mask, async () => {
      await withMaskReleased(mask, async () => undefined)
      // 内层结束后，外层仍在确认中，遮罩不该被重新武装
      seen.push(mask.armed)
    })

    expect(seen).toEqual([false])
    expect(mask.armed).toBe(true)
  })
})

describe('createMaskReleaser', () => {
  it('卡片出现时让位，消失时恢复', () => {
    const mask = new InteractionMask()
    mask.arm()
    const release = createMaskReleaser(mask)

    release(true)
    expect(mask.armed).toBe(false)

    release(false)
    expect(mask.armed).toBe(true)
  })

  it('重复调用是幂等的', () => {
    const mask = new InteractionMask()
    mask.arm()
    const release = createMaskReleaser(mask)

    release(true)
    release(true)
    release(false)

    expect(mask.armed).toBe(true)
  })

  it('原本未武装时不误开', () => {
    const mask = new InteractionMask()
    const release = createMaskReleaser(mask)

    release(true)
    release(false)

    expect(mask.armed).toBe(false)
  })

  it('没有遮罩时是空操作', () => {
    const release = createMaskReleaser(undefined)
    expect(() => { release(true); release(false) }).not.toThrow()
  })
})
