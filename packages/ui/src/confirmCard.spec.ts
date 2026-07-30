import { beforeEach, describe, expect, it, vi } from 'vitest'
import './confirmCard'
import type { ConfirmCardData } from './confirmCard'

function createCard(overrides: Partial<ConfirmCardData> = {}) {
  const card = document.createElement('toolairlock-confirm') as HTMLElement & {
    data: ConfirmCardData | null
  }
  card.data = {
    confirmationId: 'run-1:call-1',
    title: '确认删除用户',
    rows: [
      { label: '用户', value: '张三' },
      { label: '状态', value: '待审核' }
    ],
    impact: '删除后不可恢复',
    risk: 'destructive',
    ...overrides
  }
  document.body.appendChild(card)
  return card
}

function shadow(card: HTMLElement): ShadowRoot {
  const root = card.shadowRoot
  if (!root) throw new Error('组件未创建 Shadow Root')
  return root
}

describe('确认卡片', () => {
  beforeEach(() => {
    document.body.replaceChildren()
  })

  describe('结构不可裁剪的部分', () => {
    it('渲染标题、每一行事实与影响说明', () => {
      const root = shadow(createCard())

      expect(root.textContent).toContain('确认删除用户')
      expect(root.textContent).toContain('用户')
      expect(root.textContent).toContain('张三')
      expect(root.textContent).toContain('删除后不可恢复')
    })

    it('同时提供批准与拒绝，且拒绝不得被禁用或隐藏', () => {
      const root = shadow(createCard())
      const approve = root.querySelector<HTMLButtonElement>('[part="approve"]')
      const reject = root.querySelector<HTMLButtonElement>('[part="reject"]')

      expect(approve).not.toBeNull()
      expect(reject).not.toBeNull()
      // 拒绝路径必须始终可达：把它做成 disabled 或隐藏，等于把确认变成单选题。
      expect(reject!.disabled).toBe(false)
      expect(reject!.hidden).toBe(false)
    })

    it('破坏性操作带危险标识', () => {
      const root = shadow(createCard({ risk: 'destructive' }))
      expect(root.querySelector('[part="card"]')?.getAttribute('data-risk'))
        .toBe('destructive')
    })
  })

  describe('原始请求即地面真相', () => {
    const rawRequest = {
      method: 'POST',
      url: '/api/aiccadmin/user/batchDelete',
      body: { ids: ['u_1', 'u_2'] }
    }

    it('展示 method、url 与序列化后的 body', () => {
      const root = shadow(createCard({ rawRequest }))
      const raw = root.querySelector('[part="raw"]')

      expect(raw).not.toBeNull()
      expect(raw!.textContent).toContain('POST')
      expect(raw!.textContent).toContain('/api/aiccadmin/user/batchDelete')
      expect(raw!.textContent).toContain('u_1')
      expect(raw!.textContent).toContain('u_2')
    })

    it('破坏性操作默认展开原始请求，写操作默认折叠', () => {
      const destructive = shadow(createCard({ rawRequest, risk: 'destructive' }))
      expect(destructive.querySelector<HTMLDetailsElement>('[part="raw"]')!.open)
        .toBe(true)

      const write = shadow(createCard({ rawRequest, risk: 'write' }))
      expect(write.querySelector<HTMLDetailsElement>('[part="raw"]')!.open)
        .toBe(false)
    })

    it('没有原始请求时不渲染该区块，也不留占位', () => {
      const root = shadow(createCard({ rawRequest: undefined }))
      expect(root.querySelector('[part="raw"]')).toBeNull()
    })
  })

  describe('不可信内容的转义', () => {
    it('业务数据中的标记不会成为 DOM', () => {
      // rows 的取值来自页面业务数据（客户名、备注），攻击者可以通过普通表单
      // 种进去。若用富文本方式渲染，这就是一个存储型 XSS。
      const root = shadow(createCard({
        rows: [{ label: '客户名', value: '<img src=x onerror="alert(1)">' }]
      }))

      expect(root.querySelector('img')).toBeNull()
      expect(root.textContent).toContain('<img src=x onerror="alert(1)">')
    })

    it('标题与影响说明同样转义', () => {
      const root = shadow(createCard({
        title: '<script>bad()</script>',
        impact: '<b>粗体</b>'
      }))

      expect(root.querySelector('script')).toBeNull()
      expect(root.querySelector('b')).toBeNull()
      expect(root.textContent).toContain('<script>bad()</script>')
    })
  })

  describe('交互', () => {
    it('批准与拒绝各自派发带 confirmationId 的事件', () => {
      // 两张独立卡片：同一张卡片决定一次后即锁定，见下一条用例。
      const approving = createCard()
      const approved = vi.fn()
      approving.addEventListener('approve', approved)
      shadow(approving).querySelector<HTMLButtonElement>('[part="approve"]')!.click()

      const rejecting = createCard({ confirmationId: 'run-2:call-1' })
      const rejected = vi.fn()
      rejecting.addEventListener('reject', rejected)
      shadow(rejecting).querySelector<HTMLButtonElement>('[part="reject"]')!.click()

      expect((approved.mock.calls[0][0] as CustomEvent).detail)
        .toEqual({ confirmationId: 'run-1:call-1' })
      expect((rejected.mock.calls[0][0] as CustomEvent).detail)
        .toEqual({ confirmationId: 'run-2:call-1' })
    })

    it('决定一次后即锁定，重复点击不再派发', () => {
      // 防连点：确认后到卡片被移除之间有网络往返，用户很容易补点第二下。
      const card = createCard()
      const approved = vi.fn()
      card.addEventListener('approve', approved)

      const button = shadow(card).querySelector<HTMLButtonElement>('[part="approve"]')!
      button.click()
      button.click()

      expect(approved).toHaveBeenCalledTimes(1)
    })

    it('批准后拒绝亦失效，不会出现一次交互产生两个决定', () => {
      const card = createCard()
      const rejected = vi.fn()
      card.addEventListener('reject', rejected)

      shadow(card).querySelector<HTMLButtonElement>('[part="approve"]')!.click()
      shadow(card).querySelector<HTMLButtonElement>('[part="reject"]')!.click()

      expect(rejected).not.toHaveBeenCalled()
    })

    it('事件冒出 Shadow 边界，宿主可在元素上直接监听', () => {
      const card = createCard()
      const onDocument = vi.fn()
      document.addEventListener('approve', onDocument)

      shadow(card).querySelector<HTMLButtonElement>('[part="approve"]')!.click()

      expect(onDocument).toHaveBeenCalledTimes(1)
      document.removeEventListener('approve', onDocument)
    })
  })

  it('样式隔离：组件内容位于 Shadow Root，不进宿主文档树', () => {
    const card = createCard()
    expect(card.shadowRoot).not.toBeNull()
    expect(document.querySelector('[part="approve"]')).toBeNull()
  })
})

