/**
 * 针对 Vue 2 + Element UI 2.15 真实渲染结果的验证。
 *
 * 夹具**不是手编的**：由 aicc-admin-front 的 node_modules 里真实的 Vue 2.6 +
 * Element UI 2.15 在 jsdom 中挂载后导出，仅去掉了与本测试无关的滚动条和空注释节点。
 *
 * 这是本包声称要支持的目标栈（README：「要能塞进 Vue 2 + Element UI 的老后台」），
 * 因此它渲染出来的东西能不能被正确识别，是硬指标而不是加分项。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { PageController } from './controller'
import { capturePage, formatSnapshot } from './snapshot'

function render(html: string): void {
  const parsed = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  document.body.replaceChildren(
    ...Array.from(parsed.body.childNodes).map(node => document.importNode(node, true))
  )
}

/** el-input：label 与控件是兄弟节点，且 label[for] 指向一个不存在的 id。 */
const EL_INPUT = `
<div class="el-form-item">
  <label for="name" class="el-form-item__label">名称</label>
  <div class="el-form-item__content">
    <div class="el-input el-input--suffix">
      <input type="text" autocomplete="off" placeholder="请输入名称" class="el-input__inner">
    </div>
  </div>
</div>`

/** el-select：渲染成 readonly 的 text input，下拉项藏在 display:none 的浮层里。 */
const EL_SELECT = `
<div class="el-form-item">
  <label for="status" class="el-form-item__label">公司状态</label>
  <div class="el-form-item__content">
    <div class="el-select">
      <div class="el-input el-input--suffix">
        <input type="text" readonly="readonly" autocomplete="off" placeholder="公司状态" class="el-input__inner">
        <span class="el-input__suffix"><span class="el-input__suffix-inner">
          <i class="el-select__caret el-input__icon el-icon-arrow-up"></i>
        </span></span>
      </div>
      <div class="el-select-dropdown el-popper" style="display: none;">
        <div class="el-scrollbar">
          <ul class="el-scrollbar__view el-select-dropdown__list">
            <li class="el-select-dropdown__item"><span>停用</span></li>
            <li class="el-select-dropdown__item"><span>启用</span></li>
          </ul>
        </div>
      </div>
    </div>
  </div>
</div>`

/** el-button：图标 + span 文本。 */
const EL_BUTTON = `
<button type="button" class="el-button el-button--primary">
  <i class="el-icon-search"></i><span>搜索</span>
</button>`

beforeEach(() => {
  document.body.replaceChildren()
})

describe('Element UI —— el-button', () => {
  it('识别为 button，并从内层 span 取到文本', () => {
    render(EL_BUTTON)

    expect(capturePage().elements[0]).toMatchObject({ role: 'button', name: '搜索' })
  })

  it('图标类名不污染可访问名', () => {
    render(EL_BUTTON)

    expect(capturePage().elements[0].name).not.toContain('el-icon')
  })
})

describe('Element UI —— el-input', () => {
  it('label 与控件是兄弟节点且 for 悬空，退回 placeholder 仍可用', () => {
    // Element UI 的 labelFor 取的是 prop（这里是 name），但它并不会给 input 加同名 id，
    // 因此 label[for=name] 恒为悬空引用。这不是本包能修的，只能保证退化后仍可识别。
    render(EL_INPUT)

    expect(capturePage().elements[0]).toMatchObject({
      role: 'textbox',
      name: '请输入名称'
    })
  })
})

describe('Element UI —— el-select（真实栈上的关键分歧）', () => {
  it('必须识别为 combobox，而不是可输入的文本框', () => {
    // el-select 渲染的是 readonly 的 text input。若判成 textbox，模型会尝试往里
    // 打字——那在 Element UI 上完全无效，且会让模型误以为已经填好了筛选条件。
    render(EL_SELECT)

    expect(capturePage().elements[0]).toMatchObject({
      role: 'combobox',
      name: '公司状态'
    })
  })

  it('隐藏的下拉浮层不进快照', () => {
    render(EL_SELECT)

    const names = capturePage().elements.map(e => e.name)
    expect(names).not.toContain('停用')
    expect(names).not.toContain('启用')
  })

  it('拒绝向 combobox 打字，并提示改用选择', () => {
    render(EL_SELECT)
    const controller = new PageController()
    controller.capture()

    expect(() => controller.input(0, '启用')).toThrow(/只读|改用选择/)
  })
})

describe('Element UI —— readonly 输入框（通用规则）', () => {
  it('readonly 的文本框标记为只读，模型据此不再尝试输入', () => {
    render('<input type="text" readonly value="系统生成" aria-label="编号">')

    expect(capturePage().elements[0]).toMatchObject({
      role: 'textbox',
      name: '编号',
      readonly: true
    })
  })

  it('拒绝向 readonly 文本框写入', () => {
    render('<input type="text" readonly aria-label="编号">')
    const controller = new PageController()
    controller.capture()

    expect(() => controller.input(0, 'x')).toThrow(/只读/)
  })
})

describe('Element UI —— 整页快照', () => {
  it('查询表单渲染成模型可读的清单', () => {
    render(`<form class="el-form el-form--inline">${EL_INPUT}${EL_SELECT}
      <div class="el-form-item"><div class="el-form-item__content">${EL_BUTTON}</div></div>
    </form>`)

    expect(formatSnapshot(capturePage())).toBe([
      '[0] textbox 请输入名称',
      '[1] combobox 公司状态',
      '[2] button 搜索'
    ].join('\n'))
  })
})
