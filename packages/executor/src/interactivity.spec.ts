/**
 * 可交互性识别的补充信号（P1-5）。
 *
 * 语义标签 + ARIA role + `cursor: pointer` 三者已覆盖绝大多数情况，但仍有三类漏网：
 *
 * 1. **非 pointer 的交互指针**——拖拽把手是 `move`/`grab`，可编辑区域是 `text`
 * 2. **纯 JS 绑定且无指针样式**——`onclick` 属性或 `addEventListener`
 * 3. **内部滚动容器**——列表虚拟滚动、代码框，页面级 `scroll` 到不了
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

describe('扩充 cursor 集合', () => {
  it('move / grab 的拖拽把手可被发现', () => {
    render(`
      <div style="cursor:move">拖动排序</div>
      <div style="cursor:grab">拖拽面板</div>
    `)

    expect(capturePage().elements.map(e => e.name))
      .toEqual(['拖动排序', '拖拽面板'])
  })

  it('grabbing 同样识别——拖拽进行中的状态', () => {
    render('<div style="cursor:grabbing">正在拖动</div>')

    expect(capturePage().elements).toHaveLength(1)
  })

  it('text 光标不算可点——普通段落大量使用它', () => {
    // 若把 text 也算进来，整页的文字段落都会涌进快照。
    render('<p style="cursor:text">这是一段普通说明文字</p>')

    expect(capturePage().elements).toHaveLength(0)
  })

  it('默认与禁用光标一律排除', () => {
    render(`
      <div style="cursor:auto">普通</div>
      <div style="cursor:default">默认</div>
      <div style="cursor:not-allowed">禁用</div>
      <div style="cursor:wait">等待</div>
    `)

    expect(capturePage().elements).toHaveLength(0)
  })
})

describe('事件监听器兜底', () => {
  it('onclick 属性的元素可被发现——即使没有指针样式', () => {
    // 老后台大量存在 <div onclick="doSomething()"> 而不给 cursor 的写法。
    render('<div onclick="void 0">导出报表</div>')

    expect(capturePage().elements.map(e => `${e.role} ${e.name}`))
      .toEqual(['button 导出报表'])
  })

  it('onmousedown / onkeydown 同样算作可交互', () => {
    render(`
      <div onmousedown="void 0">按下触发</div>
      <div onkeydown="void 0">键盘触发</div>
    `)

    expect(capturePage().elements).toHaveLength(2)
  })

  it('没有事件也没有指针样式的普通容器不收录', () => {
    render('<div>纯展示区块</div>')

    expect(capturePage().elements).toHaveLength(0)
  })

  it('事件在祖先上时不重复收录后代', () => {
    // 事件委托很常见，若后代也算，一次点击会产出多条候选。
    // 这里只有一个绑定点，名字取整段文本是对的——重点是**只有一条**。
    render('<div onclick="void 0">外层<span onclick="void 0">内层</span></div>')

    expect(capturePage().elements).toHaveLength(1)
  })
})

describe('可滚动容器', () => {
  function makeScrollable(el: HTMLElement, scrollHeight: number): void {
    Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true })
    Object.defineProperty(el, 'clientHeight', { value: 100, configurable: true })
  }

  it('内部滚动区被识别，供模型翻阅', () => {
    // 页面级 scroll 到不了这类容器，不识别的话下半截内容对 Agent 永远不存在。
    render('<div id="list" style="overflow-y:auto;height:100px">很长的列表</div>')
    makeScrollable(document.getElementById('list') as HTMLElement, 500)

    const element = capturePage().elements[0]
    expect(element).toMatchObject({ role: 'scrollable' })
  })

  it('滚动区带方向名，且不因无自身文本被容器规则丢弃', () => {
    // 真实表格实测：横向可滚 570px 的 .el-table__body-wrapper 因无自身文本、
    // 又含大量可交互后代，被「无名纯容器」规则整个丢弃，右侧列对 Agent 永远不存在。
    render(`<div id="tbl" style="overflow-x:auto;width:100px">
      <button>第一列</button><button>第二列</button>
    </div>`)
    const box = document.getElementById('tbl') as HTMLElement
    Object.defineProperty(box, 'scrollWidth', { value: 600, configurable: true })
    Object.defineProperty(box, 'clientWidth', { value: 100, configurable: true })

    const scrollable = capturePage().elements.find(e => e.role === 'scrollable')
    expect(scrollable?.name).toBe('可滚动区域（横向）')
  })

  it('纵横皆可滚时名字含两个方向（无自身文本时才用方向名）', () => {
    // 有真实文本就用文本——它比方向名更有辨识度。
    render(`<div id="both" style="overflow-x:auto;overflow-y:auto;width:100px;height:100px">
      <button>内部按钮</button></div>`)
    const box = document.getElementById('both') as HTMLElement
    Object.defineProperty(box, 'scrollWidth', { value: 600, configurable: true })
    Object.defineProperty(box, 'clientWidth', { value: 100, configurable: true })
    Object.defineProperty(box, 'scrollHeight', { value: 600, configurable: true })
    Object.defineProperty(box, 'clientHeight', { value: 100, configurable: true })

    const scrollable = capturePage().elements.find(e => e.role === 'scrollable')
    expect(scrollable?.name).toBe('可滚动区域（纵向、横向）')
  })

  it('内容未超出时不算可滚动', () => {
    render('<div id="short" style="overflow-y:auto;height:100px">短内容</div>')
    makeScrollable(document.getElementById('short') as HTMLElement, 80)

    expect(capturePage().elements).toHaveLength(0)
  })

  it('overflow:hidden 不算可滚动', () => {
    render('<div id="hid" style="overflow:hidden;height:100px">内容</div>')
    makeScrollable(document.getElementById('hid') as HTMLElement, 500)

    expect(capturePage().elements).toHaveLength(0)
  })

  it('滚动原语能作用于内部容器', async () => {
    const { PageController } = await import('./controller')
    render('<div id="scr" style="overflow-y:auto;height:100px">内容</div>')
    const box = document.getElementById('scr') as HTMLElement
    makeScrollable(box, 500)
    let scrolledBy: number | undefined
    box.scrollBy = ((opts: ScrollToOptions) => { scrolledBy = opts.top }) as HTMLElement['scrollBy']

    const controller = new PageController({ watchRoute: false })
    const snapshot = controller.capture()
    const target = snapshot.elements.find(e => e.role === 'scrollable')
    controller.scroll(1, target?.index)

    expect(scrolledBy).toBe(100)
    controller.dispose()
  })

  it('可滚动容器不吞掉内部的可交互元素', () => {
    render(`<div id="wrap" style="overflow-y:auto;height:100px">
      <button>列表项一</button><button>列表项二</button>
    </div>`)
    makeScrollable(document.getElementById('wrap') as HTMLElement, 500)

    const names = capturePage().elements.map(e => e.name)
    expect(names).toContain('列表项一')
    expect(names).toContain('列表项二')
  })
})
