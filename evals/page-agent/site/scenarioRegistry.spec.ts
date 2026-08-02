import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getPageAgentScenario } from '../scenarios'
import {
  mountScenario,
  type MountedScenario,
  type ScenarioEvaluation
} from './scenarioRegistry'

const mountedScenarios: MountedScenario[] = []

if (false) {
  const mounted = null as unknown as MountedScenario
  const evaluation = null as unknown as ScenarioEvaluation

  // @ts-expect-error 挂载场景 ID 只读
  mounted.id = 'changed'
  // @ts-expect-error 挂载场景任务只读
  mounted.task = 'changed'
  // @ts-expect-error 场景评估方法只读
  mounted.evaluate = () => ({ passed: false, falseSuccess: false })
  // @ts-expect-error 场景重置方法只读
  mounted.reset = () => undefined
  // @ts-expect-error 场景销毁方法只读
  mounted.dispose = () => undefined
  // @ts-expect-error 评估结果只读
  evaluation.passed = false
  // @ts-expect-error 误报成功标记只读
  evaluation.falseSuccess = true
  // @ts-expect-error 评估详情只读
  evaluation.detail = 'changed'
}

function setupScenario(id: string): {
  readonly root: HTMLElement
  readonly mounted: MountedScenario
} {
  const root = document.createElement('div')
  root.innerHTML = '<div data-eval-root>旧场景</div>'
  document.body.append(root)

  const mounted = mountScenario(id, root)
  mountedScenarios.push(mounted)

  expect(mounted.id).toBe(id)
  expect(mounted.task).toBe(getPageAgentScenario(id).task)
  expect(root.querySelectorAll('[data-eval-root]')).toHaveLength(1)
  expect(mounted.evaluate('尚未完成，页面当前无法操作')).toMatchObject({
    passed: false,
    falseSuccess: false
  })
  expect(mounted.evaluate('操作已完成，已经得到结果')).toMatchObject({
    passed: false,
    falseSuccess: true
  })

  return { root, mounted }
}

function findButton(root: ParentNode, name: string): HTMLButtonElement {
  const button = Array.from(root.querySelectorAll('button')).find(
    item => item.textContent?.trim() === name
  )
  expect(button, `找不到按钮“${name}”`).toBeDefined()
  return button as HTMLButtonElement
}

function findLabeledInput(root: ParentNode, name: string): HTMLInputElement {
  const label = Array.from(root.querySelectorAll('label')).find(
    item => item.textContent?.trim() === name
  )
  expect(label, `找不到标签“${name}”`).toBeDefined()
  expect(label?.control).toBeInstanceOf(HTMLInputElement)
  return label?.control as HTMLInputElement
}

function enterValue(input: HTMLInputElement, value: string): void {
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value'
  )?.set
  valueSetter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

function expectPassedFromCurrentDom(
  root: HTMLElement,
  mounted: MountedScenario,
  answer: string
): void {
  expect(mounted.evaluate(answer)).toMatchObject({
    passed: true,
    falseSuccess: false
  })

  root.querySelector('[data-eval-root]')?.remove()
  expect(mounted.evaluate(answer).passed).toBe(false)
}

beforeEach(() => {
  document.body.innerHTML = ''
  window.history.replaceState(null, '', '/')
})

afterEach(() => {
  for (const mounted of mountedScenarios.splice(0)) {
    mounted.dispose()
  }
  vi.useRealTimers()
  document.body.innerHTML = ''
  window.history.replaceState(null, '', '/')
})

describe('mountScenario', () => {
  it('复用场景注册表的未知 ID 错误', () => {
    const root = document.createElement('div')

    expect(() => mountScenario('missing', root)).toThrowError(
      '未知网页评估场景: missing'
    )
  })

  it('仅把明确成功陈述识别为页面未完成时的误报成功', () => {
    const { mounted } = setupScenario('read-data')

    expect(mounted.evaluate('成功').falseSuccess).toBe(true)
    expect(mounted.evaluate('是否成功？').falseSuccess).toBe(false)
    expect(mounted.evaluate('请问任务完成了吗？').falseSuccess).toBe(false)
    expect(mounted.evaluate('任务完成度为 90%').falseSuccess).toBe(false)
    expect(mounted.evaluate('仍未得到结果').falseSuccess).toBe(false)
    expect(mounted.evaluate('此前失败，现已完成').falseSuccess).toBe(true)
    expect(mounted.evaluate('是否成功？现已完成').falseSuccess).toBe(true)
    expect(mounted.evaluate('任务已完成，对吗？').falseSuccess).toBe(false)
  })

  it('读取页面中的今日订单数并要求回答包含 1842', () => {
    const { root, mounted } = setupScenario('read-data')

    expect(root.textContent).toContain('今日订单数')
    expect(root.textContent).toContain('1842')
    expect(mounted.evaluate('今日订单数是 1841')).toMatchObject({
      passed: false,
      falseSuccess: false
    })

    expectPassedFromCurrentDom(root, mounted, '今日订单数是 1842')
  })

  it('从首页点击话单查询后同时更新 hash 和页面标题', () => {
    const { root, mounted } = setupScenario('navigation')

    expect(window.location.hash).toBe('')
    expect(root.querySelector('h1')?.textContent).not.toBe('话单查询')

    findButton(root, '话单查询').click()

    expect(window.location.hash).toBe('#/cdr')
    expect(root.querySelector('h1')?.textContent).toBe('话单查询')
    expectPassedFromCurrentDom(root, mounted, '已进入话单查询页面')
  })

  it('reset 将导航场景的 DOM 与 hash 一并恢复到初始状态', () => {
    const { root, mounted } = setupScenario('navigation')

    findButton(root, '话单查询').click()
    mounted.reset()

    expect(window.location.hash).toBe('')
    expect(root.querySelector('h1')?.textContent).toBe('后台首页')
    expect(root.querySelectorAll('[data-eval-root]')).toHaveLength(1)
    expect(mounted.evaluate('已进入话单查询页面').passed).toBe(false)
  })

  it('dispose 清空导航场景时同时恢复初始 hash', () => {
    const { root, mounted } = setupScenario('navigation')

    findButton(root, '话单查询').click()
    mounted.dispose()

    expect(window.location.hash).toBe('')
    expect(root.childNodes).toHaveLength(0)
  })

  it('按关键词查询后只保留张三这一条用户记录', () => {
    const { root, mounted } = setupScenario('search-filter')
    const keyword = root.querySelector<HTMLInputElement>(
      'input[aria-label="关键词"]'
    )

    expect(keyword).toBeInstanceOf(HTMLInputElement)
    expect(root.querySelector('tbody')?.textContent).toContain('张三')
    expect(root.querySelector('tbody')?.textContent).toContain('李四')

    enterValue(keyword as HTMLInputElement, '张三')
    findButton(root, '查询').click()

    const rows = Array.from(root.querySelectorAll('tbody tr'))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.textContent).toContain('张三')
    expect(rows[0]?.textContent).not.toContain('李四')
    expectPassedFromCurrentDom(root, mounted, '查询完成')
  })

  it('打开员工表单并保存王五后将其追加到列表', () => {
    const { root, mounted } = setupScenario('form')

    expect(root.querySelector('form')).toBeNull()
    expect(root.querySelector('[data-employee-list]')?.textContent).not.toContain(
      '王五'
    )

    findButton(root, '新建员工').click()
    const nameInput = findLabeledInput(root, '姓名')
    enterValue(nameInput, '王五')
    findButton(root, '保存').click()

    expect(root.querySelector('form')).toBeNull()
    expect(root.querySelector('[data-employee-list]')?.textContent).toContain(
      '王五'
    )
    expectPassedFromCurrentDom(root, mounted, '员工创建成功')
  })

  it('从组合选择框选择管理员并关闭选项浮层', () => {
    const { root, mounted } = setupScenario('composite-select')
    const role = root.querySelector<HTMLInputElement>(
      'input[aria-label="角色"]'
    )

    expect(role).toBeInstanceOf(HTMLInputElement)
    expect(role?.readOnly).toBe(true)
    expect(role?.getAttribute('role')).toBe('combobox')

    role?.click()
    expect(findButton(root, '普通员工')).toBeDefined()
    findButton(root, '管理员').click()

    expect(role?.value).toBe('管理员')
    expect(
      Array.from(root.querySelectorAll('button')).some(
        button => button.textContent?.trim() === '管理员'
      )
    ).toBe(false)
    expectPassedFromCurrentDom(root, mounted, '角色已设置为管理员')
  })

  it('保存 contenteditable 当前文本并严格匹配季度总结', () => {
    const { root, mounted } = setupScenario('rich-text')
    const editor = root.querySelector<HTMLElement>(
      '[contenteditable="true"][aria-label="公告正文"]'
    )

    expect(editor).toBeInstanceOf(HTMLElement)
    if (editor) {
      editor.textContent = '季度总结'
      editor.dispatchEvent(new InputEvent('input', { bubbles: true }))
    }
    findButton(root, '保存公告').click()

    expect(root.querySelector('[data-saved-content]')?.textContent).toBe(
      '季度总结'
    )
    expect(mounted.evaluate('已保存公告').passed).toBe(true)

    const savedContent = root.querySelector('[data-saved-content]')
    if (savedContent) savedContent.textContent = '季度总结 '
    expect(mounted.evaluate('已保存公告').passed).toBe(false)
  })

  it('展示手机号错误并在修正后创建赵六联系人', () => {
    const { root, mounted } = setupScenario('validation-recovery')
    const name = findLabeledInput(root, '姓名')
    const phone = findLabeledInput(root, '手机号')

    expect(name.value).toBe('赵六')
    enterValue(phone, '12345')
    findButton(root, '保存').click()

    expect(root.querySelector('form [role="alert"]')?.textContent).toBe(
      '手机号格式不正确'
    )
    expect(root.querySelector('[data-contact-list]')?.textContent).not.toContain(
      '赵六'
    )

    enterValue(phone, '13800138000')
    findButton(root, '保存').click()

    expect(root.querySelector('form [role="alert"]')).toBeNull()
    expect(root.querySelector('[data-contact-list]')?.textContent).toContain(
      '赵六'
    )
    expect(root.querySelector('[data-contact-list]')?.textContent).toContain(
      '13800138000'
    )
    expectPassedFromCurrentDom(root, mounted, '联系人创建成功')
  })

  it('手机号未先触发校验错误时不能通过恢复场景', () => {
    const { root, mounted } = setupScenario('validation-recovery')
    const phone = findLabeledInput(root, '手机号')

    enterValue(phone, '13800138000')
    findButton(root, '保存').click()

    expect(root.querySelector('[data-contact-list]')?.textContent).toContain(
      '13800138000'
    )
    expect(mounted.evaluate('联系人创建成功')).toMatchObject({
      passed: false,
      falseSuccess: true
    })
  })

  it('等待 1500ms 后将加载状态替换为共 27 条', () => {
    vi.useFakeTimers()
    const { root, mounted } = setupScenario('async-loading')

    findButton(root, '加载日志').click()
    expect(root.textContent).toContain('加载中')
    expect(root.textContent).not.toContain('共 27 条')

    vi.advanceTimersByTime(1499)
    expect(root.textContent).toContain('加载中')
    vi.advanceTimersByTime(1)

    expect(root.textContent).not.toContain('加载中')
    expect(root.textContent).toContain('共 27 条')
    expectPassedFromCurrentDom(root, mounted, '页面显示共 27 条')
  })

  it('缺少日期时以同时追问开始和结束日期作为成功结果', () => {
    const { root, mounted } = setupScenario('ask-user')

    expect(root.querySelector('h1')).toBeNull()
    expect(findLabeledInput(root, '开始日期').value).toBe('')
    expect(findLabeledInput(root, '结束日期').value).toBe('')
    expect(root.querySelector('[role="alert"]')).toBeNull()
    expect(mounted.evaluate('请提供开始日期和结束日期。')).toMatchObject({
      passed: true,
      falseSuccess: false
    })
    expect(mounted.evaluate('请提供需要导出的日期范围。').passed).toBe(true)

    findButton(root, '导出').click()

    expect(root.querySelector('[role="alert"]')?.textContent).toBe(
      '缺少日期范围'
    )
    expect(mounted.evaluate('请提供开始日期和结束日期。').passed).toBe(false)
  })

  it('跨两次动态弹窗替换后删除过期草稿', () => {
    const { root, mounted } = setupScenario('dynamic-dom')

    expect(root.querySelector('[data-draft-list]')?.textContent).toContain(
      '过期草稿'
    )
    findButton(root, '删除').click()

    expect(root.querySelector('[role="dialog"]')).not.toBeNull()
    findButton(root, '继续').click()

    expect(
      Array.from(root.querySelectorAll('button')).some(
        button => button.textContent?.trim() === '继续'
      )
    ).toBe(false)
    findButton(root, '确认').click()

    expect(root.querySelector('[role="dialog"]')).toBeNull()
    expect(root.querySelector('[data-draft-list]')?.textContent).not.toContain(
      '过期草稿'
    )
    expect(root.textContent).toContain('删除成功')
    expectPassedFromCurrentDom(root, mounted, '删除已完成')
  })

  it('reset 清理异步计时器并恢复唯一初始根节点', () => {
    vi.useFakeTimers()
    const { root, mounted } = setupScenario('async-loading')

    findButton(root, '加载日志').click()
    mounted.reset()

    expect(root.querySelectorAll('[data-eval-root]')).toHaveLength(1)
    expect(root.textContent).not.toContain('加载中')
    expect(findButton(root, '加载日志')).toBeDefined()
    vi.advanceTimersByTime(1500)
    expect(root.textContent).not.toContain('共 27 条')
  })

  it('reset 清理旧动态弹窗监听并恢复草稿列表', () => {
    const { root, mounted } = setupScenario('dynamic-dom')

    findButton(root, '删除').click()
    const staleContinue = findButton(root, '继续')
    mounted.reset()
    staleContinue.click()

    expect(root.querySelectorAll('[data-eval-root]')).toHaveLength(1)
    expect(root.querySelector('[role="dialog"]')).toBeNull()
    expect(root.querySelector('[data-draft-list]')?.textContent).toContain(
      '过期草稿'
    )
    expect(root.textContent).not.toContain('删除成功')
  })

  it('dispose 清理计时器、监听器并清空挂载根节点', () => {
    vi.useFakeTimers()
    const { root, mounted } = setupScenario('async-loading')

    findButton(root, '加载日志').click()
    const staleEvalRoot = root.querySelector('[data-eval-root]') as HTMLElement
    mounted.dispose()
    vi.advanceTimersByTime(1500)

    expect(root.childNodes).toHaveLength(0)
    expect(staleEvalRoot.textContent).not.toContain('共 27 条')
  })
})
