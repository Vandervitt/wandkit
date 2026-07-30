import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PageController } from './controller'

function render(html: string): void {
  const parsed = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  document.body.replaceChildren(
    ...Array.from(parsed.body.childNodes).map(node => document.importNode(node, true))
  )
}

beforeEach(() => {
  document.body.replaceChildren()
})

describe('PageController —— 索引回指', () => {
  it('capture 之后可按索引点击对应元素', () => {
    render('<button>A</button><button>B</button>')
    const clicked = vi.fn()
    document.querySelectorAll('button')[1].addEventListener('click', clicked)
    const controller = new PageController()

    controller.capture()
    controller.click(1)

    expect(clicked).toHaveBeenCalledTimes(1)
  })

  it('未先 capture 就动作会明确报错，而不是操作到错的元素上', () => {
    render('<button>A</button>')
    const controller = new PageController()

    expect(() => controller.click(0)).toThrow(/capture/)
  })

  it('索引越界报错并带上有效范围', () => {
    render('<button>A</button>')
    const controller = new PageController()
    controller.capture()

    expect(() => controller.click(5)).toThrow(/0-0/)
  })

  it('DOM 变化后旧索引失效，必须重新 capture', () => {
    // 逐步重读的核心约束：模型拿到的索引只对那一次快照有效。
    render('<button>A</button><button>B</button>')
    const controller = new PageController()
    controller.capture()

    render('<button>C</button>')

    expect(() => controller.click(1)).toThrow(/不在当前文档中/)
  })
})

describe('PageController —— 路由变化作废索引', () => {
  it('路由跳转后旧索引立即失效，报错点明原因', async () => {
    render('<button>A</button>')
    const controller = new PageController()
    controller.capture()

    history.pushState({}, '', '/other-page')
    await Promise.resolve()

    expect(() => controller.click(0)).toThrow(/已跳转|重新读取/)
    controller.dispose()
  })

  it('重新读取后恢复可用', async () => {
    render('<button>A</button>')
    const controller = new PageController()
    controller.capture()
    history.pushState({}, '', '/another')
    await Promise.resolve()

    controller.capture()

    expect(() => controller.click(0)).not.toThrow()
    controller.dispose()
  })

  it('关闭 watchRoute 后不再侦测', async () => {
    render('<button>A</button>')
    const controller = new PageController({ watchRoute: false })
    controller.capture()

    history.pushState({}, '', '/no-watch')
    await Promise.resolve()

    expect(() => controller.click(0)).not.toThrow()
    controller.dispose()
  })

  it('dispose 后还原 history 方法', () => {
    const original = history.pushState
    const controller = new PageController()
    expect(history.pushState).not.toBe(original)

    controller.dispose()

    expect(history.pushState).toBe(original)
  })
})

describe('PageController —— 输入', () => {
  it('写入文本并派发 input/change 事件，框架才能感知', () => {
    render('<input type="text" aria-label="关键词">')
    const input = document.querySelector('input') as HTMLInputElement
    const onInput = vi.fn()
    const onChange = vi.fn()
    input.addEventListener('input', onInput)
    input.addEventListener('change', onChange)
    const controller = new PageController()
    controller.capture()

    controller.input(0, '张三')

    expect(input.value).toBe('张三')
    expect(onInput).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('对 textarea 同样生效', () => {
    render('<textarea aria-label="备注"></textarea>')
    const controller = new PageController()
    controller.capture()

    controller.input(0, '备注内容')

    expect((document.querySelector('textarea') as HTMLTextAreaElement).value).toBe('备注内容')
  })

  it('向不可输入的元素写文本报错', () => {
    render('<button>A</button>')
    const controller = new PageController()
    controller.capture()

    expect(() => controller.input(0, 'x')).toThrow(/不支持输入/)
  })
})

describe('PageController —— 禁用元素', () => {
  it('拒绝点击禁用元素，而不是静默失败', () => {
    // 静默失败会让模型以为点成功了，然后基于错误前提继续推理。
    render('<button disabled>提交</button>')
    const controller = new PageController()
    controller.capture()

    expect(() => controller.click(0)).toThrow(/已禁用/)
  })
})

describe('PageController —— 下拉选择', () => {
  it('按可见文本选中选项', async () => {
    render(`
      <select aria-label="状态">
        <option value="1">待审核</option>
        <option value="2">已通过</option>
      </select>
    `)
    const controller = new PageController()
    controller.capture()

    await controller.select(0, '已通过')

    expect((document.querySelector('select') as HTMLSelectElement).value).toBe('2')
  })

  it('选项不存在时报错并列出可选项', async () => {
    render('<select aria-label="状态"><option value="1">待审核</option></select>')
    const controller = new PageController()
    controller.capture()

    await expect(controller.select(0, '不存在')).rejects.toThrow(/待审核/)
  })
})

/**
 * 组件库（AntD / Element Plus / 各家自研）的下拉几乎都不是原生 `<select>`，而是
 * 「readonly input 或 combobox 触发器 + 浮层里的 role=option」。只支持原生 select
 * 会让这类控件变成死路：input 原语拒绝它（只读），select 原语也拒绝它（不是 select），
 * 模型两头碰壁后会宣布自己无法操作系统——真实接入实测到的正是这一幕。
 *
 * 用 `role="option"` 作为契约而不是各家 class 名：ARIA 角色是组件库共同遵守的东西，
 * 绑 class 名等于每接一个新 UI 库就要改一次代码。
 */
describe('PageController —— 复合下拉（组件库）', () => {
  /** 点击触发器后异步挂出浮层，模拟组件库的真实时序。 */
  function mountCombobox(options: string[]): { picked: string[] } {
    const picked: string[] = []
    render('<input readonly role="combobox" aria-expanded="false" aria-label="角色">')
    const trigger = document.querySelector('input') as HTMLInputElement
    trigger.addEventListener('click', () => {
      if (trigger.getAttribute('aria-expanded') === 'true') return
      trigger.setAttribute('aria-expanded', 'true')
      const popup = document.createElement('div')
      popup.setAttribute('role', 'listbox')
      options.forEach(text => {
        const option = document.createElement('div')
        option.setAttribute('role', 'option')
        option.textContent = text
        option.addEventListener('click', () => {
          picked.push(text)
          trigger.value = text
          trigger.setAttribute('aria-expanded', 'false')
          popup.remove()
        })
        popup.appendChild(option)
      })
      document.body.appendChild(popup)
    })
    return { picked }
  }

  it('点开浮层后按可见文本选中 role=option', async () => {
    const { picked } = mountCombobox(['管理员', '坐席', '质检'])
    const controller = new PageController()
    controller.capture()

    await controller.select(0, '坐席')

    expect(picked).toEqual(['坐席'])
    expect((document.querySelector('input') as HTMLInputElement).value).toBe('坐席')
  })

  it('浮层里没有目标选项时报错并列出实际可选项', async () => {
    mountCombobox(['管理员', '坐席'])
    const controller = new PageController()
    controller.capture()

    await expect(controller.select(0, '不存在')).rejects.toThrow(/管理员、坐席/)
  })

  it('隐藏的浮层选项不参与匹配', async () => {
    // 组件库常把上一个下拉的浮层留在 DOM 里只做隐藏。拿它来匹配会点到一个用户
    // 看不见的选项上，而工具照样报成功——比选不中危险得多。
    render(`
      <div role="listbox" style="display: none">
        <div role="option">陈旧选项</div>
      </div>
      <input readonly role="combobox" aria-label="角色">
    `)
    const controller = new PageController()
    controller.capture()

    await expect(controller.select(0, '陈旧选项')).rejects.toThrow(/没有可选项|陈旧选项/)
  })
})

describe('PageController —— 滚动', () => {
  const realScrollBy = window.scrollBy

  // documentElement 上的 defineProperty 是持久的，会泄漏到后面的用例，让「整页可滚」
  // 的假设错误地生效——那样回退分支根本不会被执行，测试通过与否就不再说明问题。
  beforeEach(() => {
    ;['scrollHeight', 'clientHeight'].forEach(prop => {
      delete (document.documentElement as unknown as Record<string, unknown>)[prop]
    })
    window.scrollBy = realScrollBy
  })

  /**
   * jsdom 没有布局，所有元素的尺寸恒为 0，`scrollBy` 也不改 `scrollTop`。
   * 这里手工造出「有内容可滚」的容器，并把 `scrollBy` 实现成真的动 `scrollTop`。
   */
  function makeScrollable(
    element: Element,
    { clientHeight, scrollHeight, clientWidth = 1000 }:
      { clientHeight: number, scrollHeight: number, clientWidth?: number }
  ): HTMLElement {
    const box = element as HTMLElement
    Object.defineProperty(box, 'clientHeight', { value: clientHeight, configurable: true })
    Object.defineProperty(box, 'clientWidth', { value: clientWidth, configurable: true })
    Object.defineProperty(box, 'scrollHeight', { value: scrollHeight, configurable: true })
    let top = 0
    Object.defineProperty(box, 'scrollTop', {
      get: () => top,
      set: value => { top = Math.max(0, Math.min(value, scrollHeight - clientHeight)) },
      configurable: true
    })
    box.scrollBy = (options?: ScrollToOptions | number) => {
      const delta = typeof options === 'number' ? options : options?.top ?? 0
      box.scrollTop = top + delta
    }
    return box
  }

  it('页面滚不动时回退到页面内最大的滚动容器', () => {
    // 管理后台几乎都是这个布局：window 不滚，内容区是独立的 overflow 容器。模型分不清
    // 该滚哪个——它说「往下滚」时滚了整页，页面没动，于是它以为下面没有内容了。
    // 这个判断不该交给模型：页面滚不动是个可观测的事实，代码自己能看出来。
    render('<div id="outer" style="overflow-y:auto"><button>底部按钮</button></div>')
    const content = makeScrollable(document.getElementById('outer')!, {
      clientHeight: 600, scrollHeight: 2000
    })
    // 整页不可滚：scrollBy 调了也不动
    const scrollBy = vi.fn()
    vi.stubGlobal('scrollY', 0)
    window.scrollBy = scrollBy as unknown as typeof window.scrollBy

    const controller = new PageController()
    controller.capture()
    controller.scroll(1)

    expect(content.scrollTop).toBeGreaterThan(0)
  })

  it('整页本身可滚时就滚整页，不去碰内部容器', () => {
    render('<div id="outer" style="overflow-y:auto"><button>底部按钮</button></div>')
    const content = makeScrollable(document.getElementById('outer')!, {
      clientHeight: 600, scrollHeight: 2000
    })
    // 造一个「整页可滚」的文档
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      value: 5000, configurable: true
    })
    Object.defineProperty(document.documentElement, 'clientHeight', {
      value: 800, configurable: true
    })
    const scrollBy = vi.fn()
    window.scrollBy = scrollBy as unknown as typeof window.scrollBy

    const controller = new PageController()
    controller.capture()
    controller.scroll(1)

    expect(scrollBy).toHaveBeenCalled()
    expect(content.scrollTop).toBe(0)
  })

  it('回退时挑正文那块，而不是同样能滚的侧边菜单', () => {
    // 侧边菜单常常也能滚，但它窄。按滚动高度挑会挑到它，正文依然不动。
    render(`
      <nav id="menu" style="overflow-y:auto"></nav>
      <div id="main" style="overflow-y:auto"><button>底部按钮</button></div>
    `)
    const menu = makeScrollable(document.getElementById('menu')!, {
      clientHeight: 700, scrollHeight: 9000, clientWidth: 200
    })
    const main = makeScrollable(document.getElementById('main')!, {
      clientHeight: 600, scrollHeight: 2000, clientWidth: 1200
    })
    window.scrollBy = vi.fn() as unknown as typeof window.scrollBy

    const controller = new PageController()
    controller.capture()
    controller.scroll(1)

    expect(main.scrollTop).toBeGreaterThan(0)
    expect(menu.scrollTop).toBe(0)
  })

  it('显式给了索引就只滚那个容器', () => {
    render('<div id="outer" style="overflow-y:auto"><button>底部按钮</button></div>')
    const content = makeScrollable(document.getElementById('outer')!, {
      clientHeight: 600, scrollHeight: 2000
    })
    const controller = new PageController()
    const snapshot = controller.capture()
    const index = snapshot.elements.findIndex(e => e.role === 'scrollable')

    controller.scroll(1, index)

    expect(content.scrollTop).toBeGreaterThan(0)
  })
})
