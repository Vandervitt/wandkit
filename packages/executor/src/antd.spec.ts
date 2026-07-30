/**
 * ant-design-vue 4 —— 与 Element UI 不同的包装结构。
 *
 * 真实接入实测（aicc-front，Vue 3 + AntD 4）：一个单选项被收录了三次，名字完全相同，
 * 模型无从选择，清单长度还膨胀三倍。
 *
 *     <label class="ant-radio-wrapper" style="cursor:pointer">   cursor:pointer，无 role
 *       <span class="ant-radio" style="cursor:pointer">          cursor:pointer，无 role
 *         <input type="radio">
 *       상담원 개인 설정
 *
 * 三层的可访问名都从同一段后代文本算出来，因此「无名容器才丢弃」那条规则一个都拦不住。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { capturePage } from './snapshot'

// 夹具把 cursor 写成内联样式：真实浏览器里它来自 AntD 的样式表，而 jsdom 不解析
// class 对应的 CSS。不这么写，包装层根本不会被收录，用例会假绿。
function render(html: string): void {
  const parsed = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  document.body.replaceChildren(
    ...Array.from(parsed.body.childNodes).map(node => document.importNode(node, true))
  )
}

beforeEach(() => {
  document.body.replaceChildren()
})

describe('AntD 单选：三层包装只留真正的控件', () => {
  it('同一个选项不会重复成三项', () => {
    render(`
      <label class="ant-radio-wrapper" style="cursor:pointer">
        <span class="ant-radio" style="cursor:pointer"><input type="radio" class="ant-radio-input"></span>
        <span>坐席个人设置</span>
      </label>`)

    const named = capturePage().elements.filter(e => e.name === '坐席个人设置')
    expect(named).toHaveLength(1)
  })

  it('留下的是那个 input，不是外面的包装层', () => {
    render(`
      <label class="ant-radio-wrapper" style="cursor:pointer">
        <span class="ant-radio" style="cursor:pointer"><input type="radio" class="ant-radio-input"></span>
        <span>坐席个人设置</span>
      </label>`)

    expect(capturePage().elements.map(e => e.role)).toEqual(['radio'])
  })

  it('一组选项各自成项，彼此可区分', () => {
    render(`
      <div>
        <label class="ant-radio-wrapper" style="cursor:pointer">
          <span class="ant-radio" style="cursor:pointer"><input type="radio" class="ant-radio-input"></span>
          <span>坐席个人设置</span>
        </label>
        <label class="ant-radio-wrapper" style="cursor:pointer">
          <span class="ant-radio" style="cursor:pointer"><input type="radio" class="ant-radio-input"></span>
          <span>统一设置</span>
        </label>
      </div>`)

    expect(capturePage().elements.map(e => e.name)).toEqual(['坐席个人设置', '统一设置'])
  })
})

describe('作者显式声明的操作目标不受影响', () => {
  it('可展开菜单的父项保留——点它会展开子菜单', () => {
    render(`
      <li role="menuitem">系统管理
        <ul><li role="menuitem">用户管理</li></ul>
      </li>`)

    expect(capturePage().elements.map(e => e.name)).toEqual(['系统管理', '用户管理'])
  })

  it('链接里套按钮时，链接本身仍在——丢了就丢了导航能力', () => {
    render('<a href="/detail"><div><button>查看</button></div>详情</a>')

    expect(capturePage().elements.map(e => e.role)).toContain('link')
  })
})

describe('label 内的文字不重复成正文', () => {
  it('选项文字已经是控件的名字，不再单独占一行', () => {
    // 被丢弃的 label 不会进祖先栈，「已被祖先用掉的文本」那条去重查不到它
    render(`
      <label class="ant-radio-wrapper" style="cursor:pointer">
        <span class="ant-radio" style="cursor:pointer"><input type="radio"></span>
        <span>坐席个人设置</span>
      </label>`)

    expect(capturePage().texts.map(t => t.text)).not.toContain('坐席个人设置')
  })

  it('label 之外的正文照常收录', () => {
    render(`
      <p>共 3 个坐席</p>
      <label style="cursor:pointer"><input type="checkbox"><span>全选</span></label>`)

    expect(capturePage().texts.map(t => t.text)).toEqual(['共 3 个坐席'])
  })
})
