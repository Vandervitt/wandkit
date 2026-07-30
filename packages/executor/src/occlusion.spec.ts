/**
 * 遮挡判定：区分「真被盖住」与「同位置重叠」。
 *
 * 真实后台实测（Element UI 固定列）暴露出单点 `elementFromPoint` 的不足：表格开启
 * 固定列后，同一行按钮在 DOM 里存在两份——主表格一份、`.el-table__fixed-right`
 * 副本一份。主表格那份被固定列容器完全盖住，`elementFromPoint` 命中的是副本层的
 * 别的按钮，于是整列操作按钮全部被排除。
 *
 * 关键区别：
 * - **真被盖住**（弹窗遮罩下的元素）——用户点不到，必须排除
 * - **同位置重叠**（固定列副本、粘性表头）——用户点得到，不能排除
 *
 * `elementsFromPoint` 返回该点上的完整命中栈，能穿透重叠层，正是这个区分所需的。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { capturePage } from './snapshot'

function render(html: string): void {
  const parsed = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  document.body.replaceChildren(
    ...Array.from(parsed.body.childNodes).map(node => document.importNode(node, true))
  )
}

/**
 * jsdom 无布局引擎，需同时伪造矩形与命中栈。
 *
 * @param stacks 坐标点上的命中栈，按元素 id 给出（栈顶在前）。
 */
function fakeLayout(
  rects: Record<string, [number, number, number, number]>,
  stacks: (x: number, y: number) => Element[]
): void {
  Object.entries(rects).forEach(([id, [left, top, width, height]]) => {
    const el = document.getElementById(id)
    if (!el) throw new Error(`夹具缺少 #${id}`)
    el.getBoundingClientRect = () => ({
      left, top, width, height,
      right: left + width, bottom: top + height,
      x: left, y: top, toJSON: () => ({})
    }) as DOMRect
    Object.defineProperty(el, 'offsetWidth', { value: width, configurable: true })
    Object.defineProperty(el, 'offsetHeight', { value: height, configurable: true })
  })
  document.documentElement.getBoundingClientRect = () => ({
    left: 0, top: 0, width: 1400, height: 800,
    right: 1400, bottom: 800, x: 0, y: 0, toJSON: () => ({})
  }) as DOMRect
  // 视口判定读的是 window 尺寸，jsdom 默认 1024x768，这里对齐夹具坐标系
  Object.defineProperty(window, 'innerWidth', { value: 1400, configurable: true })
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true })
  document.elementsFromPoint = vi.fn(stacks) as typeof document.elementsFromPoint
  document.elementFromPoint = ((x: number, y: number) => stacks(x, y)[0] ?? null) as
    typeof document.elementFromPoint
}

beforeEach(() => {
  document.body.replaceChildren()
})

describe('同位置重叠不算被遮挡', () => {
  it('固定列副本盖住主表格按钮时，仍能收录到其中一份', () => {
    // Element UI 固定列会把整行 DOM 复制一份，两份按钮位置重叠。
    render(`
      <button id="main">详情</button>
      <div id="fixed"><button id="copy">详情</button></div>
    `)
    const main = document.getElementById('main') as HTMLElement
    const copy = document.getElementById('copy') as HTMLElement
    fakeLayout(
      { main: [1378, 293, 26, 14], copy: [1378, 293, 26, 14], fixed: [1204, 280, 240, 600] },
      // 栈顶是副本层，但主表格按钮也在栈中——两者都在同一个点上
      () => [copy, document.getElementById('fixed') as Element, main]
    )

    expect(capturePage().elements.some(e => e.name === '详情')).toBe(true)
  })

  it('元素在命中栈中即视为可点，无需是栈顶', () => {
    render('<div id="overlay">遮罩</div><button id="btn">确定</button>')
    const btn = document.getElementById('btn') as HTMLElement
    const overlay = document.getElementById('overlay') as HTMLElement
    fakeLayout(
      { btn: [100, 100, 80, 30], overlay: [0, 0, 1400, 800] },
      () => [overlay, btn]
    )

    expect(capturePage().elements.some(e => e.name === '确定')).toBe(true)
  })
})

describe('真正被盖住仍要排除', () => {
  it('元素完全不在命中栈中时排除——弹窗遮罩下的底层元素', () => {
    // 这条守的是遮挡判定的本职：弹窗打开时底层元素用户点不到，不能进快照。
    render(`
      <button id="under">底层按钮</button>
      <div id="dialog"><button id="confirm">确 定</button></div>
    `)
    const dialog = document.getElementById('dialog') as HTMLElement
    const confirm = document.getElementById('confirm') as HTMLElement
    fakeLayout(
      { under: [100, 100, 80, 30], dialog: [400, 50, 600, 500], confirm: [800, 480, 80, 30] },
      (x: number) => x < 400 ? [dialog] : [confirm, dialog]
    )

    const names = capturePage().elements.map(e => e.name)
    expect(names).not.toContain('底层按钮')
    expect(names).toContain('确 定')
  })
})

/**
 * 视口外扩收进来的元素不能被遮挡判定误杀。
 *
 * 真实后台实测：侧边栏「话单查询」在 `top=812`、视口高 812，靠 `viewportExpansion`
 * 被有意收录，但 `elementsFromPoint(x, 812)` 在视口外恒返回空，于是被判成「被遮挡」
 * 而整项消失。模型只看得到它的文字、拿不到索引，去猜了个邻近下标——点成了「数据报表」。
 */
describe('视口外的元素无从判定遮挡', () => {
  it('取样点全在视口外时按未遮挡处理，元素照常收录', () => {
    render('<button id="menu">话单查询</button>')
    const menu = document.getElementById('menu') as HTMLElement
    // 刚好滚出下边缘：视口过滤靠外扩仍会收它，而 elementsFromPoint 在视口外恒空
    fakeLayout({ menu: [0, 800, 200, 50] }, () => [])

    expect(capturePage().elements.map(e => e.name)).toContain('话单查询')
    expect(menu.isConnected).toBe(true)
  })

  it('视口内确实被盖住的元素照旧排除，兜底没有被放宽', () => {
    render('<button id="under">确定</button><div id="cover"></div>')
    const cover = document.getElementById('cover') as HTMLElement
    fakeLayout({ under: [100, 100, 80, 30], cover: [0, 0, 1400, 800] }, () => [cover])

    expect(capturePage().elements.map(e => e.name)).not.toContain('确定')
  })
})
