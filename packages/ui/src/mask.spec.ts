import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InteractionMask, MASK_TAG } from './mask'

/** 取当前挂载中的遮罩 Shadow Root。 */
function mask(): ShadowRoot {
  const element = document.querySelector(MASK_TAG)
  if (!element?.shadowRoot) throw new Error('遮罩未挂载')
  return element.shadowRoot
}

describe('交互遮罩', () => {
  beforeEach(() => {
    document.body.replaceChildren()
  })

  describe('归属判定的前提', () => {
    it('武装后挂载到文档，解除后彻底移除', () => {
      const m = new InteractionMask()

      m.arm()
      expect(document.querySelector(MASK_TAG)).not.toBeNull()

      m.disarm()
      expect(document.querySelector(MASK_TAG)).toBeNull()
    })

    it('覆盖整个视口并置于最高层', () => {
      const m = new InteractionMask()
      m.arm()

      const overlay = mask().querySelector<HTMLElement>('[part="overlay"]')!
      expect(overlay.style.position).toBe('fixed')
      expect(overlay.style.inset).toBe('0px')
      // 必须压过宿主所有弹层，否则用户仍能点到下面的业务按钮，
      // 「窗口内的请求必然来自 Agent」这个前提就不成立了。
      // 组件库的 z-index 常年在 2000~3000，老后台里手写 9999 的也不少。
      expect(Number(overlay.style.zIndex)).toBeGreaterThan(100000)
      // 但要给治理界面留一档——确认卡片必须能压过遮罩，否则用户点不到闸门。
      expect(Number(overlay.style.zIndex)).toBeLessThan(2147483647)
    })

    it('吞掉指针与键盘事件，不让它们抵达业务页面', () => {
      const m = new InteractionMask()
      const onBodyClick = vi.fn()
      const onBodyKey = vi.fn()
      document.body.addEventListener('click', onBodyClick)
      document.body.addEventListener('keydown', onBodyKey)
      m.arm()

      const overlay = mask().querySelector<HTMLElement>('[part="overlay"]')!
      overlay.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }))
      overlay.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', bubbles: true, composed: true
      }))

      expect(onBodyClick).not.toHaveBeenCalled()
      expect(onBodyKey).not.toHaveBeenCalled()

      document.body.removeEventListener('click', onBodyClick)
      document.body.removeEventListener('keydown', onBodyKey)
    })
  })

  describe('重入与清理', () => {
    it('重复武装不产生第二层遮罩', () => {
      const m = new InteractionMask()
      m.arm()
      m.arm()

      expect(document.querySelectorAll(MASK_TAG)).toHaveLength(1)
    })

    it('未武装时解除是空操作，不抛错', () => {
      const m = new InteractionMask()
      expect(() => m.disarm()).not.toThrow()
    })

    it('armed 如实反映当前状态', () => {
      const m = new InteractionMask()
      expect(m.armed).toBe(false)
      m.arm()
      expect(m.armed).toBe(true)
      m.disarm()
      expect(m.armed).toBe(false)
    })
  })

  describe('可见性与提示', () => {
    it('展示宿主给定的状态文案', () => {
      const m = new InteractionMask({ label: '正在执行：删除用户' })
      m.arm()

      expect(mask().textContent).toContain('正在执行：删除用户')
    })

    it('状态文案按纯文本渲染', () => {
      // 文案可能来自模型输出，同样不可信。
      const m = new InteractionMask({ label: '<img src=x onerror="alert(1)">' })
      m.arm()

      expect(mask().querySelector('img')).toBeNull()
      expect(mask().textContent).toContain('<img src=x onerror="alert(1)">')
    })

    it('武装后可更新文案，不需要重挂', () => {
      const m = new InteractionMask({ label: '第一步' })
      m.arm()
      m.setLabel('第二步')

      expect(document.querySelectorAll(MASK_TAG)).toHaveLength(1)
      expect(mask().textContent).toContain('第二步')
      expect(mask().textContent).not.toContain('第一步')
    })

    it('透明模式仍然拦截交互，只是不遮挡视线', () => {
      // 用户需要看清 Agent 在页面上做了什么，遮挡会让操作变成黑箱。
      const m = new InteractionMask({ transparent: true })
      m.arm()

      const overlay = mask().querySelector<HTMLElement>('[part="overlay"]')!
      expect(overlay.getAttribute('data-transparent')).toBe('true')
      expect(overlay.style.pointerEvents).not.toBe('none')
    })
  })

  it('无障碍：标注为忙碌态并接管焦点', () => {
    const m = new InteractionMask({ label: '执行中' })
    m.arm()

    const overlay = mask().querySelector<HTMLElement>('[part="overlay"]')!
    expect(overlay.getAttribute('aria-busy')).toBe('true')
    expect(overlay.getAttribute('role')).toBe('alert')
  })
})
