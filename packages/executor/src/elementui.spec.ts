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

describe('Element UI —— el-select（框架无关的处理方式）', () => {
  it('标记为只读，不臆测它是下拉框', () => {
    // el-select 渲染的是 readonly 的 text input。原始 DOM 里没有任何信息能把它与
    // 「只读展示字段」区分开——Element UI 不提供 ARIA。因此只陈述事实（只读、
    // 不可输入），不靠类名去猜它的组件类型。
    // Agent 拿到「只读」就知道唯一能做的是点击；点开后重读页面，选项自然出现。
    render(EL_SELECT)

    expect(capturePage().elements[0]).toMatchObject({
      name: '公司状态',
      readonly: true
    })
  })

  it('隐藏的下拉浮层不进快照', () => {
    render(EL_SELECT)

    const names = capturePage().elements.map(e => e.name)
    expect(names).not.toContain('停用')
    expect(names).not.toContain('启用')
  })

  it('拒绝向只读控件打字，并提示改用选择', () => {
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

describe('容器不得吞掉整棵子树的文本', () => {
  /**
   * 真实后台实测：Element UI 侧边栏的 `<ul class="el-menu">` 有 104 个可交互后代，
   * 取子树 textContent 会得到一个 236 字符、把所有菜单项串在一起的名字——既无法
   * 辨识，又白烧 token。
   */
  const MENU = `
    <ul role="menu">
      <li role="menuitem"><div style="cursor:pointer">系统管理</div>
        <ul role="menu">
          <li role="menuitem"><div style="cursor:pointer">用户管理</div></li>
          <li role="menuitem"><div style="cursor:pointer">角色管理</div></li>
        </ul>
      </li>
    </ul>`

  it('容器名不含后代文本', () => {
    render(MENU)

    const names = capturePage().elements.map(e => e.name)
    expect(names).not.toContain('系统管理用户管理角色管理')
    expect(names.every(n => n.length < 20)).toBe(true)
  })

  it('无名纯容器整个不收录，真正可点的子项照常收录', () => {
    render(MENU)

    expect(capturePage().elements.map(e => e.name).sort())
      .toEqual(['用户管理', '系统管理', '角色管理'].sort())
  })

  it('有自己直接文本的容器仍然收录', () => {
    render(`<li role="menuitem">系统管理<ul role="menu">
      <li role="menuitem"><span style="cursor:pointer">用户管理</span></li>
    </ul></li>`)

    expect(capturePage().elements.map(e => e.name)).toContain('系统管理')
  })
})

describe('cursor 兜底不得产出重复项', () => {
  /**
   * 真实浏览器实测发现的问题：`<button><span>删除</span></button>` 里 button 按标签
   * 命中，内层 span 因继承了 cursor:pointer 又命中一次，快照出现两条「删除」。
   * 模型无从选择，且嵌套越深重复越多。
   */
  it('按钮内的 span 不单独成项', () => {
    render(`<button class="el-button" style="cursor:pointer">
      <i class="el-icon-delete" style="cursor:pointer"></i><span style="cursor:pointer">删除</span>
    </button>`)

    const names = capturePage().elements.map(e => e.name)
    expect(names).toEqual(['删除'])
  })

  it('包着按钮的可点容器不单独成项', () => {
    render(`<div style="cursor:pointer">
      <button style="cursor:pointer">修改</button>
    </div>`)

    expect(capturePage().elements.map(e => e.name)).toEqual(['修改'])
  })

  it('表格操作列的两个按钮各出现一次', () => {
    render(`<td class="el-table__cell"><div class="cell" style="cursor:auto">
      <button class="el-button" style="cursor:pointer"><span style="cursor:pointer">修改</span></button>
      <button class="el-button" style="cursor:pointer"><span style="cursor:pointer">删除</span></button>
    </div></td>`)

    expect(capturePage().elements.map(e => e.name)).toEqual(['修改', '删除'])
  })
})

describe('Element UI —— 整页快照', () => {
  it('查询表单渲染成模型可读的清单', () => {
    render(`<form class="el-form el-form--inline">${EL_INPUT}${EL_SELECT}
      <div class="el-form-item"><div class="el-form-item__content">${EL_BUTTON}</div></div>
    </form>`)

    expect(formatSnapshot(capturePage())).toBe([
      '[0] textbox 请输入名称',
      '[1] textbox 公司状态 (readonly)',
      '[2] button 搜索'
    ].join('\n'))
  })
})

describe('Element UI —— 下拉打开后靠重读发现选项', () => {
  /**
   * 这组用例守的是「无状态逐步重读」的核心承诺：**不需要预先知道组件类型**。
   *
   * Agent 看到只读控件 → 点它 → 重读页面 → 选项已成为普通可点元素 → 选中。
   * 全程没有任何一处依赖 `.el-select` 这类框架类名。
   */
  it('打开前抓不到选项，打开后抓得到', () => {
    render(EL_SELECT)
    expect(capturePage().elements.map(e => e.name)).not.toContain('停用')

    // 模拟点开：Element UI 移除浮层的 display:none
    const dropdown = document.querySelector('.el-select-dropdown') as HTMLElement
    dropdown.style.display = ''
    // 真实页面里下拉项由 CSS 赋予 cursor:pointer；jsdom 无样式表，这里显式给上，
    // 等价于真实浏览器中的渲染结果（已在 aicc 页面实测：值为 pointer）。
    document.querySelectorAll('.el-select-dropdown__item').forEach(item => {
      (item as HTMLElement).style.cursor = 'pointer'
    })

    const names = capturePage().elements.map(e => e.name)
    expect(names).toContain('停用')
    expect(names).toContain('启用')
  })

  it('选项即使是纯 li 也能被点击（无 role 无 tabindex）', () => {
    render(EL_SELECT)
    const dropdown = document.querySelector('.el-select-dropdown') as HTMLElement
    dropdown.style.display = ''
    document.querySelectorAll('.el-select-dropdown__item').forEach(item => {
      (item as HTMLElement).style.cursor = 'pointer'
    })

    let clicked = ''
    document.querySelectorAll('.el-select-dropdown__item').forEach(item => {
      item.addEventListener('click', () => { clicked = item.textContent?.trim() ?? '' })
    })

    const controller = new PageController()
    const snapshot = controller.capture()
    const target = snapshot.elements.find(e => e.name === '启用')
    controller.click(target?.index as number)

    expect(clicked).toBe('启用')
  })
})
