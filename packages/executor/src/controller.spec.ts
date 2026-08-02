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

describe('PageController —— Shadow DOM 动作', () => {
  it('按连续索引点击 open Shadow Root 内按钮', () => {
    const host = document.createElement('div')
    const root = host.attachShadow({ mode: 'open' })
    const button = document.createElement('button')
    button.textContent = '影子操作'
    const clicked = vi.fn()
    button.addEventListener('click', clicked)
    root.append(button)
    document.body.append(host)
    const controller = new PageController()
    const snapshot = controller.capture()

    controller.click(snapshot.elements.findIndex(element => element.name === '影子操作'))

    expect(clicked).toHaveBeenCalledTimes(1)
  })

  it('输入与原生选择操作影子树中的真实控件', async () => {
    const host = document.createElement('div')
    const root = host.attachShadow({ mode: 'open' })
    root.innerHTML = `
      <input aria-label="关键词">
      <select aria-label="状态"><option value="on">启用</option></select>
    `
    document.body.append(host)
    const input = root.querySelector('input') as HTMLInputElement
    const select = root.querySelector('select') as HTMLSelectElement
    const changed = vi.fn()
    input.addEventListener('change', changed)
    select.addEventListener('change', changed)
    const controller = new PageController()
    const snapshot = controller.capture()

    controller.input(snapshot.elements.findIndex(element => element.name === '关键词'), '客户')
    await controller.select(snapshot.elements.findIndex(element => element.name === '状态'), '启用')

    expect(input.value).toBe('客户')
    expect(select.value).toBe('on')
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it('Host 移除后影子树旧索引失效', () => {
    const host = document.createElement('div')
    const root = host.attachShadow({ mode: 'open' })
    const button = document.createElement('button')
    button.textContent = '即将移除'
    root.append(button)
    document.body.append(host)
    const controller = new PageController()
    controller.capture()
    host.remove()

    expect(() => controller.click(0)).toThrow(/已不在当前文档/)
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

  /**
   * rc-select（Ant Design Vue / React 的下拉底座）把展开监听挂在 `mousedown` 上，
   * 而不是 `click`。`element.click()` 只派发 click，浮层根本不会打开——扫不到任何
   * `role="option"`，于是报「点开后没有可选项」，模型把它转述成「这不是下拉框」。
   *
   * 这不是 Role 字段一个补丁：依赖 mousedown 的组件（下拉、日期选择、级联、
   * 自定义弹出层）都会死在同一个地方。
   */
  it('只监听 mousedown 的下拉也能打开（rc-select / AntD）', async () => {
    const picked: string[] = []
    render('<input readonly role="combobox" aria-label="Role">')
    const trigger = document.querySelector('input') as HTMLInputElement
    // 刻意只听 mousedown：监听 click 的话这条用例就退化成上面那些，测不到东西。
    trigger.addEventListener('mousedown', () => {
      const popup = document.createElement('div')
      popup.setAttribute('role', 'listbox')
      const option = document.createElement('div')
      option.setAttribute('role', 'option')
      option.textContent = '坐席'
      option.addEventListener('mousedown', () => {
        picked.push('坐席')
        trigger.value = '坐席'
        popup.remove()
      })
      popup.appendChild(option)
      document.body.appendChild(popup)
    })
    const controller = new PageController()
    controller.capture()

    await controller.select(0, '坐席')

    expect(picked).toEqual(['坐席'])
  })

  /**
   * rc-select 的真实结构：`role="combobox"` 在**内层** input 上，外层是
   * `.ant-select-selector`；浮层则 `position: absolute` 挂在 body 末尾，与触发器
   * 在 DOM 上毫无父子关系。
   *
   * 快照收录的往往是外层那个（它才是有尺寸、看得见的那块），因此按索引拿到的元素
   * 身上既没有 `aria-expanded` 也没有 `aria-controls`。浮层与触发器不相邻这一点也
   * 决定了：搜集选项不能从触发器往下找，只能全局找。
   */
  it('触发器是外层包装、浮层挂在 body 上时同样可选（rc-select 真实结构）', async () => {
    const picked: string[] = []
    render(`
      <div class="ant-select-selector" tabindex="0">
        <input type="search" role="combobox" readonly aria-expanded="false"
               aria-controls="rc_select_3_list" aria-label="Role">
        <span>Please select</span>
      </div>
    `)
    const selector = document.querySelector('.ant-select-selector') as HTMLElement
    selector.addEventListener('mousedown', () => {
      const popup = document.createElement('div')
      // 与触发器同级挂在 body 末尾，而不是嵌在它内部——这是 absolute 浮层的常态。
      popup.id = 'rc_select_3_list'
      popup.setAttribute('role', 'listbox')
      ;['管理员', '坐席'].forEach(text => {
        const option = document.createElement('div')
        option.setAttribute('role', 'option')
        option.textContent = text
        option.addEventListener('mousedown', () => {
          picked.push(text)
          popup.remove()
        })
        popup.appendChild(option)
      })
      document.body.appendChild(popup)
    })
    const controller = new PageController()
    const snapshot = controller.capture()
    const index = snapshot.elements.findIndex(
      element => element.name === 'Role' || element.role === 'combobox'
    )

    await controller.select(index, '坐席')

    expect(picked).toEqual(['坐席'])
  })

  it('Shadow Host 内部已展开时不重复点击触发器', async () => {
    const picked = vi.fn()
    const reopened = vi.fn()
    const host = document.createElement('div')
    host.setAttribute('role', 'combobox')
    host.setAttribute('aria-label', '角色')
    host.addEventListener('mousedown', reopened)
    const root = host.attachShadow({ mode: 'open' })
    const state = document.createElement('span')
    state.setAttribute('aria-expanded', 'true')
    root.append(state)
    const option = document.createElement('button')
    option.textContent = '坐席'
    option.addEventListener('mousedown', picked)
    document.body.append(host, option)
    const controller = new PageController()
    const snapshot = controller.capture()
    const index = snapshot.elements.findIndex(element => element.name === '角色')

    await controller.select(index, '坐席')

    expect(reopened).not.toHaveBeenCalled()
    expect(picked).toHaveBeenCalledTimes(1)
  })

  it('Shadow Root 内触发器继承 Host 的展开状态', async () => {
    const picked = vi.fn()
    const reopened = vi.fn()
    const host = document.createElement('div')
    host.setAttribute('aria-expanded', 'true')
    const root = host.attachShadow({ mode: 'open' })
    const trigger = document.createElement('button')
    trigger.textContent = '角色'
    trigger.addEventListener('mousedown', reopened)
    root.append(trigger)
    const option = document.createElement('button')
    option.textContent = '坐席'
    option.addEventListener('mousedown', picked)
    document.body.append(host, option)
    const controller = new PageController()
    const snapshot = controller.capture()
    const index = snapshot.elements.findIndex(element => element.name === '角色')

    await controller.select(index, '坐席')

    expect(reopened).not.toHaveBeenCalled()
    expect(picked).toHaveBeenCalledTimes(1)
  })

  it('匹配选项时排除 Shadow Host 内部元素', async () => {
    const internalPicked = vi.fn()
    const optionPicked = vi.fn()
    const host = document.createElement('div')
    host.setAttribute('role', 'combobox')
    host.setAttribute('aria-label', '角色')
    host.setAttribute('aria-expanded', 'true')
    const root = host.attachShadow({ mode: 'open' })
    const internal = document.createElement('button')
    internal.textContent = '坐席'
    internal.addEventListener('mousedown', internalPicked)
    root.append(internal)
    const option = document.createElement('button')
    option.textContent = '坐席'
    option.addEventListener('mousedown', optionPicked)
    document.body.append(host, option)
    const controller = new PageController()
    const snapshot = controller.capture()
    const index = snapshot.elements.findIndex(element => element.name === '角色')

    await controller.select(index, '坐席')

    expect(internalPicked).not.toHaveBeenCalled()
    expect(optionPicked).toHaveBeenCalledTimes(1)
  })

  /**
   * rc-select 的选项**没有 `role="option"`**。
   *
   * 真实页面实测（AntD Vue 4）：`aria-controls` 指向的 `rc_select_N_list` 是一个纯
   * 无障碍镜像——里面 4 个 `role="option"` 全是空文本、不可见、无 class 的占位 div，
   * 只用于 `aria-activedescendant`。真正的可见选项是 `.ant-select-item-option`，
   * 挂在另一棵 `.ant-select-dropdown` 树上，**不带任何 role**。
   *
   * 于是「认 role=option」这条契约恰好命中了诱饵：扫到 4 个空节点，可见性一过滤就
   * 全没了，报「点开后也没有可选项」。模型连试四次后放弃，转头去点了别的元素。
   *
   * 结论：选项不能靠属性契约找，只能靠「点开之后新出现、且看得见、且可点」——
   * 这正是快照本来就在算的东西。
   */
  it('选项没有 role=option 时，靠「新出现的可点元素」找到它', async () => {
    const picked: string[] = []
    render('<div class="trigger" style="cursor:pointer" aria-label="Role">Please select</div>')
    const trigger = document.querySelector('.trigger') as HTMLElement
    trigger.addEventListener('mousedown', () => {
      const popup = document.createElement('div')
      // 无障碍镜像：空文本、不可见，正是 rc-select 会摆在 aria-controls 后面的东西。
      const mirror = document.createElement('div')
      mirror.style.display = 'none'
      ;['', ''].forEach(() => {
        const ghost = document.createElement('div')
        ghost.setAttribute('role', 'option')
        mirror.appendChild(ghost)
      })
      document.body.appendChild(mirror)
      // 真正的选项：有文本、可点，但没有 role。
      ;['管理员', '坐席'].forEach(text => {
        const item = document.createElement('div')
        // 无 role、无 tabindex，只有一个 cursor: pointer——这正是
        // `.ant-select-item-option` 在真实浏览器里的样子。
        item.style.cursor = 'pointer'
        item.textContent = text
        item.addEventListener('mousedown', () => {
          picked.push(text)
          popup.remove()
        })
        popup.appendChild(item)
      })
      document.body.appendChild(popup)
    })
    const controller = new PageController()
    controller.capture()

    await controller.select(0, '坐席')

    expect(picked).toEqual(['坐席'])
  })

  it('点开后确实没有任何选项时，报告实情而不是硬说「不是下拉框」', async () => {
    render('<button>普通按钮</button>')
    const controller = new PageController()
    controller.capture()

    await expect(controller.select(0, '坐席')).rejects.toThrow(/没有出现任何可选项/)
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

    await expect(controller.select(0, '陈旧选项')).rejects.toThrow(/没有出现任何可选项/)
  })
})

describe('PageController —— 表单校验', () => {
  it('识别 open Shadow Root 内的表单校验错误', () => {
    const host = document.createElement('div')
    const root = host.attachShadow({ mode: 'open' })
    root.innerHTML = '<form><div role="alert">名称不能为空</div></form>'
    document.body.append(host)

    expect(new PageController().validationErrors()).toEqual(['名称不能为空'])
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

  it('页面不可滚时回退到影子树内最大的滚动容器', () => {
    const host = document.createElement('div')
    const root = host.attachShadow({ mode: 'open' })
    const content = document.createElement('div')
    content.style.overflowY = 'auto'
    root.append(content)
    document.body.append(host)
    const scrollable = makeScrollable(content, { clientHeight: 600, scrollHeight: 2000 })
    window.scrollBy = vi.fn() as unknown as typeof window.scrollBy
    const controller = new PageController()
    controller.capture()

    controller.scroll(1)

    expect(scrollable.scrollTop).toBeGreaterThan(0)
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
