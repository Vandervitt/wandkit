import { beforeEach, describe, expect, it } from 'vitest'
import { capturePage, formatSnapshot } from './snapshot'

/** 用 DOMParser 装载测试夹具，避免对活动文档赋值 innerHTML。 */
function render(html: string): void {
  const parsed = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  document.body.replaceChildren(
    ...Array.from(parsed.body.childNodes).map(node => document.importNode(node, true))
  )
}

beforeEach(() => {
  document.body.replaceChildren()
})

describe('capturePage —— 可交互元素识别', () => {
  it('收录按钮、链接、输入框、下拉框', () => {
    render(`
      <button>删除用户</button>
      <a href="/users">用户列表</a>
      <input type="text" placeholder="搜索">
      <select><option>全部</option></select>
      <textarea></textarea>
    `)

    expect(capturePage().elements.map(e => e.role)).toEqual([
      'button', 'link', 'textbox', 'combobox', 'textbox'
    ])
  })

  it('忽略纯展示元素', () => {
    render('<div>说明文字</div><p>段落</p><span>标签</span>')

    expect(capturePage().elements).toHaveLength(0)
  })

  it('显式 role 覆盖标签推断', () => {
    render('<div role="button" tabindex="0">自定义按钮</div>')

    expect(capturePage().elements[0]).toMatchObject({
      role: 'button',
      name: '自定义按钮'
    })
  })

  it('区分 checkbox 与 radio', () => {
    render(`
      <input type="checkbox" aria-label="全选">
      <input type="radio" aria-label="按月">
    `)

    expect(capturePage().elements.map(e => e.role)).toEqual(['checkbox', 'radio'])
  })

  it('没有 href 的 a 不算链接', () => {
    render('<a>纯文本锚点</a>')

    expect(capturePage().elements).toHaveLength(0)
  })
})

describe('capturePage —— 可访问名（生产构建后唯一可靠的线索）', () => {
  it('aria-label 优先于文本内容', () => {
    render('<button aria-label="删除用户 张三">删除</button>')

    expect(capturePage().elements[0].name).toBe('删除用户 张三')
  })

  it('aria-labelledby 解析引用元素的文本', () => {
    render('<span id="t">批量导出</span><button aria-labelledby="t">GO</button>')

    expect(capturePage().elements[0].name).toBe('批量导出')
  })

  it('label for 关联到表单控件', () => {
    render('<label for="kw">关键词</label><input id="kw" type="text">')

    expect(capturePage().elements[0].name).toBe('关键词')
  })

  it('包裹式 label 同样生效', () => {
    render('<label>手机号<input type="text"></label>')

    expect(capturePage().elements[0].name).toBe('手机号')
  })

  it('无 label 时退回 placeholder', () => {
    render('<input type="text" placeholder="请输入用户名">')

    expect(capturePage().elements[0].name).toBe('请输入用户名')
  })

  it('input[type=submit] 取 value', () => {
    render('<input type="submit" value="提交表单">')

    expect(capturePage().elements[0]).toMatchObject({ role: 'button', name: '提交表单' })
  })

  it('折叠空白，避免多行文本把快照撑爆', () => {
    render('<button>  删除\n\n   用户  </button>')

    expect(capturePage().elements[0].name).toBe('删除 用户')
  })

  it('CSS class 与组件名不参与识别（生产构建后它们已失效）', () => {
    render('<button class="_dangerButton_wukff_1">删除</button>')

    const element = capturePage().elements[0]
    expect(element.name).toBe('删除')
    expect(JSON.stringify(element)).not.toContain('wukff')
  })
})

describe('capturePage —— 不可见元素', () => {
  it('跳过 display:none', () => {
    render('<button style="display:none">隐藏</button><button>可见</button>')

    expect(capturePage().elements.map(e => e.name)).toEqual(['可见'])
  })

  it('跳过 visibility:hidden', () => {
    render('<button style="visibility:hidden">隐藏</button>')

    expect(capturePage().elements).toHaveLength(0)
  })

  it('跳过 hidden 属性与 aria-hidden', () => {
    render('<button hidden>A</button><button aria-hidden="true">B</button>')

    expect(capturePage().elements).toHaveLength(0)
  })

  it('祖先隐藏时后代也不收录', () => {
    render('<div style="display:none"><button>子按钮</button></div>')

    expect(capturePage().elements).toHaveLength(0)
  })
})

describe('capturePage —— 状态', () => {
  it('记录禁用状态，避免模型去点点不动的按钮', () => {
    render('<button disabled>已禁用</button>')

    expect(capturePage().elements[0].disabled).toBe(true)
  })

  it('记录勾选状态与当前值', () => {
    render(`
      <input type="checkbox" aria-label="全选" checked>
      <input type="text" aria-label="关键词" value="张三">
    `)

    const [checkbox, textbox] = capturePage().elements
    expect(checkbox.checked).toBe(true)
    expect(textbox.value).toBe('张三')
  })
})

describe('capturePage —— 索引', () => {
  it('索引从 0 连续递增，供动作原语回指', () => {
    render('<button>A</button><button>B</button><button>C</button>')

    expect(capturePage().elements.map(e => e.index)).toEqual([0, 1, 2])
  })
})

describe('capturePage —— composed tree', () => {
  it('普通 DOM、影子树和 slot 内容按渲染顺序共享连续索引', () => {
    const before = document.createElement('button')
    before.textContent = '之前'
    const host = document.createElement('section')
    const root = host.attachShadow({ mode: 'open' })
    const group = document.createElement('div')
    group.setAttribute('role', 'button')
    group.setAttribute('aria-label', '影子组')
    const slot = document.createElement('slot')
    slot.name = 'action'
    group.append(slot)
    root.append(group)
    const assigned = document.createElement('button')
    assigned.slot = 'action'
    assigned.textContent = '分发按钮'
    host.append(assigned)
    const after = document.createElement('button')
    after.textContent = '之后'
    document.body.append(before, host, after)

    expect(capturePage().elements.map(element => ({
      index: element.index,
      name: element.name,
      depth: element.depth
    }))).toEqual([
      { index: 0, name: '之前', depth: 0 },
      { index: 1, name: '影子组', depth: 0 },
      { index: 2, name: '分发按钮', depth: 1 },
      { index: 3, name: '之后', depth: 0 }
    ])
  })

  it('slot 分发文本成为内部按钮的可访问名', () => {
    const host = document.createElement('div')
    host.textContent = '保存'
    const root = host.attachShadow({ mode: 'open' })
    const button = document.createElement('button')
    button.append(document.createElement('slot'))
    root.append(button)
    document.body.append(host)

    expect(capturePage().elements[0]).toMatchObject({ role: 'button', name: '保存' })
  })

  it('隐藏 Host 会隐藏 open Shadow Root 内部元素', () => {
    const host = document.createElement('div')
    host.hidden = true
    const root = host.attachShadow({ mode: 'open' })
    const button = document.createElement('button')
    button.textContent = '不可见'
    root.append(button)
    document.body.append(host)

    expect(capturePage().elements).toHaveLength(0)
  })

  it('Shadow Root 内 aria-labelledby 与 label[for] 在本 Tree Scope 解析', () => {
    const host = document.createElement('div')
    const root = host.attachShadow({ mode: 'open' })
    root.innerHTML = `
      <span id="button-name">影子导出</span>
      <button aria-labelledby="button-name">GO</button>
      <label for="keyword">关键词</label>
      <input id="keyword">
    `
    document.body.append(host)

    expect(capturePage().elements.map(element => element.name))
      .toEqual(['影子导出', '关键词'])
  })

  it('关闭 cursor 推断时仍穿透影子树收录语义控件', () => {
    const host = document.createElement('div')
    const root = host.attachShadow({ mode: 'open' })
    root.innerHTML = '<button>语义按钮</button><div style="cursor:pointer">推断按钮</div>'
    document.body.append(host)

    expect(capturePage(document, { detectClickableCursor: false }).elements.map(e => e.name))
      .toEqual(['语义按钮'])
  })
})

describe('formatSnapshot', () => {
  it('渲染成模型易读的带索引文本', () => {
    render(`
      <button>删除用户</button>
      <input type="text" aria-label="关键词" value="张三">
      <button disabled>导出</button>
    `)

    expect(formatSnapshot(capturePage())).toBe([
      '[0] button 删除用户',
      '[1] textbox 关键词 = "张三"',
      '[2] button 导出 (disabled)'
    ].join('\n'))
  })

  it('没有元素也没有正文时给出明确说明，而不是交出一段空白', () => {
    render('<div></div>')

    expect(formatSnapshot(capturePage())).toBe('(当前页面没有可交互元素)')
  })

  it('只有正文、没有可交互元素时，正文照样交给模型', () => {
    // 详情页、报表页大量属于这一类。当成空页面处理，模型就永远读不到结论。
    render('<div>今日话单合计 1842 条</div>')

    expect(formatSnapshot(capturePage())).toContain('1842')
  })
})
