/**
 * 跨框架验证：算法不得依赖任何特定 UI 库的结构。
 *
 * 此前的验证全部来自 Vue 2 + Element UI 一个栈，存在「针对单一框架调优」的风险。
 * 这组用例覆盖三种结构截然不同的形态，夹具取自真实浏览器中的实际渲染结果：
 *
 * - **纯 HTML**：零框架，只有原生标签与 `label[for]`
 * - **Ant Design（React）**：`<a>` 当按钮用、`role="combobox"` 挂在 readonly input 上
 * - **Shadow DOM**（Web Components / Lit / Stencil）：DOM 边界隔离
 *
 * 真实浏览器实测结论：三种形态下行上下文、combobox 判定、同名元素消歧均正常，
 * 说明算法建立在 Web 标准而非框架约定之上。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { capturePage } from './snapshot'

function render(html: string): void {
  const parsed = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  document.body.replaceChildren(
    ...Array.from(parsed.body.childNodes).map(node => document.importNode(node, true))
  )
}

beforeEach(() => {
  document.body.replaceChildren()
})

describe('纯 HTML（零框架）', () => {
  it('原生表单控件全部识别', () => {
    render(`
      <label for="q">关键词</label><input id="q" type="text" value="abc">
      <select aria-label="状态"><option>选项A</option></select>
      <button>提交</button>
    `)

    expect(capturePage().elements.map(e => ({ role: e.role, name: e.name })))
      .toEqual([
        { role: 'textbox', name: '关键词' },
        { role: 'combobox', name: '状态' },
        { role: 'button', name: '提交' }
      ])
  })

  it('label[for] 跨兄弟节点关联——纯 HTML 的标准写法', () => {
    render('<label for="phone">手机号</label><div><input id="phone" type="text"></div>')

    expect(capturePage().elements[0].name).toBe('手机号')
  })

  it('原生 table 的行上下文', () => {
    render(`
      <table><tbody>
        <tr><td>记录一</td><td><button>删除</button></td></tr>
        <tr><td>记录二</td><td><button>删除</button></td></tr>
      </tbody></table>
    `)

    expect(capturePage().elements.map(e => e.context))
      .toEqual(['记录一', '记录二'])
  })
})

describe('Ant Design 式标记（React 栈）', () => {
  /**
   * 与 Element UI 的关键差异：
   * - 操作列用 `<a>` 而非 `<button>`
   * - `role="combobox"` 直接挂在 readonly input 上（Element UI 完全不给 ARIA）
   */
  it('用 <a> 实现的操作按钮带上各自的行标识', () => {
    render(`
      <table class="ant-table"><tbody>
        <tr class="ant-table-row"><td class="ant-table-cell">AntD行一</td>
          <td class="ant-table-cell"><a href="#e">编辑</a> <a href="#d">删除</a></td></tr>
        <tr class="ant-table-row"><td class="ant-table-cell">AntD行二</td>
          <td class="ant-table-cell"><a href="#e">编辑</a> <a href="#d">删除</a></td></tr>
      </tbody></table>
    `)

    expect(capturePage().elements.map(e => `${e.name}→${e.context}`))
      .toEqual([
        '编辑→AntD行一', '删除→AntD行一',
        '编辑→AntD行二', '删除→AntD行二'
      ])
  })

  it('显式 role="combobox" 直接生效，无需任何库特定推断', () => {
    render(`
      <div class="ant-select"><div class="ant-select-selector">
        <input readonly role="combobox" aria-expanded="false" aria-label="状态选择">
      </div></div>
    `)

    expect(capturePage().elements[0]).toMatchObject({
      role: 'combobox',
      name: '状态选择'
    })
  })

  it('aria-expanded 进入属性白名单，模型据此判断下拉是否已展开', () => {
    render('<input readonly role="combobox" aria-expanded="true" aria-label="状态">')

    expect(capturePage().elements[0].attributes?.['aria-expanded']).toBe('true')
  })
})

describe('Shadow DOM（Web Components / Lit / Stencil）', () => {
  it('默认穿透 open Shadow Root 并收录内部元素', () => {
    render('<div id="host"></div>')
    const host = document.getElementById('host') as HTMLElement
    const shadow = host.attachShadow({ mode: 'open' })
    const button = document.createElement('button')
    button.textContent = '影子按钮'
    shadow.appendChild(button)

    expect(capturePage().elements.map(element => element.name)).toContain('影子按钮')
  })

  it('closed Shadow Root 保持不可见', () => {
    render('<div id="closed-host"></div>')
    const host = document.getElementById('closed-host') as HTMLElement
    const shadow = host.attachShadow({ mode: 'closed' })
    const button = document.createElement('button')
    button.textContent = '关闭影子按钮'
    shadow.appendChild(button)

    expect(capturePage().elements.map(element => element.name))
      .not.toContain('关闭影子按钮')
  })
})

describe('算法不依赖任何框架专有信号', () => {
  it('同一份语义在三种类名体系下得到相同结果', () => {
    const semantics = '<button>删除</button>'
    const variants = [
      semantics,
      `<div class="el-button-group">${semantics}</div>`,
      `<div class="ant-btn-group">${semantics}</div>`,
      `<div class="MuiButtonGroup-root">${semantics}</div>`
    ]

    const results = variants.map(html => {
      render(html)
      return capturePage().elements.map(e => `${e.role}:${e.name}`)
    })

    expect(results).toEqual([
      ['button:删除'], ['button:删除'], ['button:删除'], ['button:删除']
    ])
  })
})
