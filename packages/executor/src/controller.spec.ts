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
  it('按可见文本选中选项', () => {
    render(`
      <select aria-label="状态">
        <option value="1">待审核</option>
        <option value="2">已通过</option>
      </select>
    `)
    const controller = new PageController()
    controller.capture()

    controller.select(0, '已通过')

    expect((document.querySelector('select') as HTMLSelectElement).value).toBe('2')
  })

  it('选项不存在时报错并列出可选项', () => {
    render('<select aria-label="状态"><option value="1">待审核</option></select>')
    const controller = new PageController()
    controller.capture()

    expect(() => controller.select(0, '不存在')).toThrow(/待审核/)
  })
})
