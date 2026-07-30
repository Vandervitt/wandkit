/**
 * 快照输出格式：层级、属性、新元素标记。
 *
 * 三者都是为了回答模型的同一类问题——「这个元素到底是什么，属于谁，是不是我刚才
 * 那次操作弄出来的」。扁平无属性的清单在真实后台里回答不了任何一个。
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

beforeEach(() => {
  document.body.replaceChildren()
})

describe('属性白名单——补上图标按钮的身份', () => {
  it('无可访问名时 title 进入名字', () => {
    // 真实后台实测：33% 的元素是图标按钮，没有任何文本，模型无从辨识。
    render('<button title="展开菜单"><i></i></button>')

    expect(capturePage().elements[0].name).toBe('展开菜单')
  })

  it('保留白名单内的属性供模型辨识', () => {
    render('<button aria-haspopup="true" aria-expanded="false" title="更多操作"></button>')

    expect(capturePage().elements[0].attributes).toMatchObject({
      'aria-haspopup': 'true',
      'aria-expanded': 'false'
    })
  })

  it('不在白名单的属性一律丢弃', () => {
    render('<button class="el-button" data-v-abc123 style="color:red">删除</button>')

    const attributes = capturePage().elements[0].attributes ?? {}
    expect(Object.keys(attributes)).not.toContain('class')
    expect(Object.keys(attributes)).not.toContain('style')
  })

  it('属性值超长时截断，避免撑爆预算', () => {
    render(`<button title="${'很长'.repeat(40)}">x</button>`)

    const title = capturePage().elements[0].attributes?.title ?? ''
    expect(title.length).toBeLessThanOrEqual(21)
  })

  it('与 name 完全相同的属性不重复输出', () => {
    render('<button aria-label="删除用户">删除用户</button>')

    expect(capturePage().elements[0].attributes?.['aria-label']).toBeUndefined()
  })

  it('凭据字段的属性同样脱敏', () => {
    // page-agent 的白名单含 value，照搬会把密码明文送进模型。
    render('<input type="password" name="password" title="admin123" value="admin123">')

    expect(JSON.stringify(capturePage().elements[0])).not.toContain('admin123')
  })
})

describe('层级——让表格里的多个「删除」可区分', () => {
  it('嵌套的可交互元素带上层级', () => {
    render(`
      <div role="menuitem" tabindex="0">系统管理
        <div role="menuitem" tabindex="0">用户管理</div>
      </div>
    `)

    const elements = capturePage().elements
    expect(elements.map(e => ({ name: e.name, depth: e.depth })))
      .toEqual([
        { name: '系统管理', depth: 0 },
        { name: '用户管理', depth: 1 }
      ])
  })

  it('平级元素层级相同', () => {
    render('<button>A</button><button>B</button>')

    expect(capturePage().elements.map(e => e.depth)).toEqual([0, 0])
  })

  it('格式化输出用缩进表达层级', () => {
    render(`
      <div role="menuitem" tabindex="0">系统管理
        <div role="menuitem" tabindex="0">用户管理</div>
      </div>
      <button>搜索</button>
    `)

    expect(formatSnapshot(capturePage())).toBe([
      '[0] menuitem 系统管理',
      '  [1] menuitem 用户管理',
      '[2] button 搜索'
    ].join('\n'))
  })
})

describe('行上下文——表格里同名按钮的真正解法', () => {
  /**
   * 层级缩进解决不了表格：`<tr>` 通常既无 `role` 也无 `tabindex`，本身不可交互，
   * 不会进入快照，因此「删除」按钮之间没有可区分的父节点。
   * 真正管用的是把所在行的文本带上。
   */
  const TABLE = `
    <table><tbody>
      <tr><td>国光科技</td><td><button>删除</button></td></tr>
      <tr><td>示例公司</td><td><button>删除</button></td></tr>
    </tbody></table>`

  it('同名按钮带上各自的行文本', () => {
    render(TABLE)

    expect(capturePage().elements.map(e => e.context))
      .toEqual(['国光科技', '示例公司'])
  })

  it('格式化输出把行上下文跟在后面，正文按文档序插在元素之间', () => {
    render(TABLE)

    // 单元格文本既是行上下文，也是页面正文——两者用途不同，都要有：括号里的
    // 上下文供模型消歧同名按钮，独立成行的正文让模型读得到表格里的数据本身。
    expect(formatSnapshot(capturePage())).toBe([
      '国光科技',
      '[0] button 删除 (国光科技)',
      '示例公司',
      '[1] button 删除 (示例公司)'
    ].join('\n'))
  })

  it('行文本与元素名相同时不重复输出', () => {
    render('<table><tbody><tr><td><button>删除</button></td></tr></tbody></table>')

    expect(capturePage().elements[0].context).toBeUndefined()
  })

  it('真实表格行取首格作标识，而非整行文本', () => {
    // 真实后台实测：一行 187 字符（含状态、计费、时间等 10 个单元格），整行文本既超长
    // 又淹没重点；而首格 "wzp ID: 76" 恰好就是这条记录的标识。首列即标识是后台表格的
    // 通例。
    render(`
      <table><tbody>
        <tr>
          <td>wzp ID: 76</td><td>启用 并发: 10 任务: 0 坐席: 1</td>
          <td>admin（1916）账号: admin</td><td>后付 单独计费 余额: -0.02</td>
          <td><button>详情</button><button>编辑</button></td>
        </tr>
      </tbody></table>`)

    expect(capturePage().elements.map(e => ({ name: e.name, context: e.context })))
      .toEqual([
        { name: '详情', context: 'wzp ID: 76' },
        { name: '编辑', context: 'wzp ID: 76' }
      ])
  })

  it('行内含下拉菜单等嵌套列表时依然取得到首格', () => {
    // 真实页面的操作列带「更多」下拉，其浮层里是 <li>，会让整行不再是「叶子行」。
    render(`
      <table><tbody>
        <tr>
          <td>国光科技</td>
          <td><button>详情</button>
            <ul><li>删除</li><li>停用</li></ul>
          </td>
        </tr>
      </tbody></table>`)

    expect(capturePage().elements.find(e => e.name === '详情')?.context)
      .toBe('国光科技')
  })

  it('列表项文本过长时放弃——那多半取到了整块区域而非一条记录', () => {
    render(`<ul><li>${'很长的说明'.repeat(20)}<button>删除</button></li></ul>`)

    expect(capturePage().elements[0].context).toBeUndefined()
  })

  it('表格首格超长时截断而非丢弃——它仍是这一行唯一的标识', () => {
    render(`<table><tbody><tr><td>${'很长的说明'.repeat(20)}</td>
      <td><button>删除</button></td></tr></tbody></table>`)

    const context = capturePage().elements[0].context ?? ''
    expect(context.length).toBeLessThanOrEqual(60)
    expect(context.length).toBeGreaterThan(0)
  })
})

describe('新元素标记——回答「我刚才那次点击造成了什么」', () => {
  it('首次抓取不标记任何元素为新', () => {
    render('<button>A</button>')
    const controller = new PageController({ watchRoute: false })

    expect(controller.capture().elements.every(e => !e.isNew)).toBe(true)
    controller.dispose()
  })

  it('第二次抓取时新出现的元素被标记', () => {
    render('<button>A</button>')
    const controller = new PageController({ watchRoute: false })
    controller.capture()

    const added = document.createElement('button')
    added.textContent = 'B'
    document.body.appendChild(added)
    const elements = controller.capture().elements

    expect(elements.find(e => e.name === 'A')?.isNew).toBeFalsy()
    expect(elements.find(e => e.name === 'B')?.isNew).toBe(true)
    controller.dispose()
  })

  it('格式化时新元素带 * 前缀', () => {
    render('<button>A</button>')
    const controller = new PageController({ watchRoute: false })
    controller.capture()

    const added = document.createElement('button')
    added.textContent = '确认删除'
    document.body.appendChild(added)

    expect(formatSnapshot(controller.capture())).toContain('*[1] button 确认删除')
    controller.dispose()
  })
})

/**
 * 页面正文。
 *
 * 真实后台实测的缺陷：快照只收可交互元素，Agent 于是只会操作、不会阅读。首页
 * 「客户数量 75」全在 `<p>`/`<td>` 里，快照 15 行全是 button/link，问「今天有多少
 * 话单」时模型结构性失明，只能回答「找不到」。查询类请求在管理后台占大头。
 */
describe('页面正文', () => {
  it('无可交互元素的详情页照样把结论交给模型', () => {
    render('<div><h1>话单查询</h1><p>今日话单合计 1842 条</p></div>')

    const text = formatSnapshot(capturePage())
    expect(text).toContain('话单查询')
    expect(text).toContain('1842')
  })

  it('正文不占用元素索引——它点不了，给索引只会诱导模型去点', () => {
    render('<div><p>共 3 条</p><button>刷新</button></div>')

    const snapshot = capturePage()
    expect(snapshot.elements.map(e => e.name)).toEqual(['刷新'])
    expect(snapshot.texts.map(t => t.text)).toContain('共 3 条')
  })

  it('已被祖先当作可访问名用掉的文本不重复输出', () => {
    // 组件库遍地都是 <button><span>搜索</span></button>
    render('<button><span>搜索</span></button>')

    expect(formatSnapshot(capturePage())).toBe('[0] button 搜索')
  })

  it('只取直接文本，不让每层祖先都重复整段内容', () => {
    render('<div><section><p>合计 42 条</p></section></div>')

    expect(capturePage().texts.map(t => t.text)).toEqual(['合计 42 条'])
  })

  it('按文档序插回元素之间，正文与元素的从属关系不丢', () => {
    render('<div><p>第一段</p><button>甲</button><p>第二段</p><button>乙</button></div>')

    expect(formatSnapshot(capturePage())).toBe([
      '第一段',
      '[0] button 甲',
      '第二段',
      '[1] button 乙'
    ].join('\n'))
  })
})
