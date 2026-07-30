/**
 * 原语在「模型用错了」时的行为。
 *
 * 真实接入实测的缺陷：模型第一步没读页面就直接点击，控制器抛出「请先 capture 当前
 * 页面」，运行时把它归一成「工具运行失败，请稍后重试」并**终结整个 Run**——模型既
 * 看不到该怎么改，也没有下一轮可以改。用户看到的是「助手什么都没干就说失败了」。
 *
 * 这类失败是逐步重读模式下的**预期模型行为**，和参数校验失败同类，必须以 `ok: false`
 * 带原始指引回喂，让模型自己纠正。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { PageActionError, PageController } from './controller'
import { createPageTools } from './tools'

/** 取出某个原语的 execute，省掉每处都写一遍查找。 */
function toolNamed(controller: PageController, name: string) {
  const tool = createPageTools({ moduleId: 'page', owner: 'test', controller })
    .find(candidate => candidate.name === name)
  if (!tool) throw new Error(`没有名为 ${name} 的原语`)
  return (input: unknown) =>
    (tool.execute as (ctx: unknown, input: unknown) => Promise<{
      ok: boolean, message: string, data?: string, retryable?: true
    }>)({}, input)
}

function render(html: string): void {
  const parsed = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  document.body.replaceChildren(
    ...Array.from(parsed.body.childNodes).map(node => document.importNode(node, true))
  )
}

beforeEach(() => {
  document.body.replaceChildren()
})

describe('可纠正的失败以结果回喂，而不是抛出', () => {
  it('没读页面就点击：返回失败与指引，不抛异常', async () => {
    const click = toolNamed(new PageController({ watchRoute: false }), 'click')

    const result = await click({ index: 0 })

    expect(result.ok).toBe(false)
    // 指引必须原样传给模型：换成「操作失败」它就不知道下一步该读页面。
    expect(result.message).toContain('先')
    expect(result.message).toContain('页面')
  })

  it('索引越界：告诉模型有效范围', async () => {
    const button = document.createElement('button')
    button.textContent = '确定'
    document.body.appendChild(button)
    const controller = new PageController({ watchRoute: false })
    controller.capture()

    const result = await toolNamed(controller, 'click')({ index: 5 })

    expect(result.ok).toBe(false)
    expect(result.message).toContain('越界')
  })

  it('元素已脱离文档：提示重新读取', async () => {
    const button = document.createElement('button')
    button.textContent = '删除'
    document.body.appendChild(button)
    const controller = new PageController({ watchRoute: false })
    controller.capture()
    button.remove()

    const result = await toolNamed(controller, 'click')({ index: 0 })

    expect(result.ok).toBe(false)
    expect(result.message).toContain('重新读取')
  })

  it('往非输入元素里填字：说明它不支持输入', async () => {
    const button = document.createElement('button')
    button.textContent = '提交'
    document.body.appendChild(button)
    const controller = new PageController({ watchRoute: false })
    controller.capture()

    const result = await toolNamed(controller, 'input')({ index: 0, text: '你好' })

    expect(result.ok).toBe(false)
    expect(result.message).toContain('不支持输入')
  })

  it('选了不存在的选项：列出可选项', async () => {
    const select = document.createElement('select')
    select.setAttribute('aria-label', '状态')
    ;['全部', '待审核'].forEach(text => {
      const option = document.createElement('option')
      option.textContent = text
      select.appendChild(option)
    })
    document.body.appendChild(select)
    const controller = new PageController({ watchRoute: false })
    controller.capture()

    const result = await toolNamed(controller, 'select')({ index: 0, option: '已完成' })

    expect(result.ok).toBe(false)
    expect(result.message).toContain('待审核')
  })

  it('成功时照常返回 ok', async () => {
    const button = document.createElement('button')
    button.textContent = '确定'
    let clicked = false
    button.addEventListener('click', () => { clicked = true })
    document.body.appendChild(button)
    const controller = new PageController({ watchRoute: false })
    controller.capture()

    const result = await toolNamed(controller, 'click')({ index: 0 })

    expect(result.ok).toBe(true)
    expect(clicked).toBe(true)
  })
})

/**
 * 动作必须自带执行后的页面。
 *
 * 不带的话，模型每做一个动作就得再花一轮读页面。一次「新建员工」有二十来个动作，
 * 轮数直接翻倍，而每一轮都是一次模型往返——真实接入实测：Run 点了两三下就被预算
 * 掐断，用户看到的是助手做到一半停下来让他「接着点」。
 *
 * 顺带解决索引失效：结果里的清单永远是最新的，模型没有机会沿用上一轮的索引。
 */
describe('动作自带执行后的页面', () => {
  it('点击后返回的是操作之后的页面，不是操作之前的', async () => {
    render('<button>打开表单</button>')
    document.querySelector('button')?.addEventListener('click', () => {
      render('<input aria-label="姓名"><button>保存</button>')
    })
    const controller = new PageController({ watchRoute: false })
    controller.capture()

    const result = await toolNamed(controller, 'click')({ index: 0 })

    expect(result.ok).toBe(true)
    expect(result.data).toContain('保存')
    expect(result.data).not.toContain('打开表单')
  })

  it('输入后返回新页面清单', async () => {
    render('<input aria-label="姓名">')
    const controller = new PageController({ watchRoute: false })
    controller.capture()

    const result = await toolNamed(controller, 'input')({ index: 0, text: '张三' })

    expect(result.ok).toBe(true)
    expect(result.data).toContain('姓名')
  })

  it('滚动后返回新页面清单', async () => {
    render('<button>甲</button>')
    const controller = new PageController({ watchRoute: false })
    controller.capture()

    const result = await toolNamed(controller, 'scroll')({ pages: 1 })

    expect(result.ok).toBe(true)
    expect(result.data).toContain('甲')
  })

  it('复合下拉选中后返回新页面清单', async () => {
    render(`
      <input readonly role="combobox" aria-expanded="false" aria-label="角色">
      <div role="listbox"><div role="option">坐席</div></div>
    `)
    const controller = new PageController({ watchRoute: false })
    controller.capture()

    const result = await toolNamed(controller, 'select')({ index: 0, option: '坐席' })

    expect(result.ok).toBe(true)
    expect(result.data).toContain('角色')
  })

  it('失败时不带页面，只回可纠正的指引', async () => {
    render('<button>甲</button>')
    const controller = new PageController({ watchRoute: false })
    controller.capture()

    const result = await toolNamed(controller, 'click')({ index: 9 })

    expect(result.ok).toBe(false)
    expect(result.retryable).toBe(true)
    expect(result.data).toBeUndefined()
  })
})

/**
 * 动作描述用业务语言，不带元素下标。
 *
 * 这条 message 有两个去处，两边都受不了下标：界面上它就是给用户看的进度
 * （「已点击 [9]」什么也说明不了），历史里它是模型判断「我刚才干了什么」的依据
 * ——而下标不是事实，元素上写着的字才是。
 */
describe('动作描述用业务语言', () => {
  it('点击报出元素名而不是索引', async () => {
    render('<button>员工管理</button>')
    const controller = new PageController({ watchRoute: false })
    controller.capture()

    const result = await toolNamed(controller, 'click')({ index: 0 })

    expect(result.message).toBe('已点击「员工管理」')
  })

  it('点击后元素消失也不影响描述——名字在动作前就取好了', async () => {
    render('<button>员工管理</button>')
    document.querySelector('button')?.addEventListener('click', () => {
      render('<div>员工列表</div>')
    })
    const controller = new PageController({ watchRoute: false })
    controller.capture()

    const result = await toolNamed(controller, 'click')({ index: 0 })

    expect(result.message).toBe('已点击「员工管理」')
  })

  it('输入报出字段名与填入的值', async () => {
    render('<input aria-label="姓名">')
    const controller = new PageController({ watchRoute: false })
    controller.capture()

    const result = await toolNamed(controller, 'input')({ index: 0, text: '张三' })

    expect(result.message).toBe('已填写「姓名」：张三')
  })

  it('元素没有可用名称时退化成序号，而不是报个空名字', async () => {
    render('<button></button>')
    const controller = new PageController({ watchRoute: false })
    controller.capture()

    const result = await toolNamed(controller, 'click')({ index: 0 })

    expect(result.message).toBe('已点击第 0 项')
  })
})

/**
 * 表单校验没过时，动作不得回报成功。
 *
 * 真实接入实测的最严重缺陷：模型填完表单点「OK」，点击确实发生了，工具回报
 * `已点击「OK」`，模型据此宣布「已成功添加新员工」。而密码不合规、角色没选，表单被
 * 前端校验拦下，一个请求都没发出去——用户看到的是一句自信的成功，和一个红着两处
 * 错误、什么也没提交的弹窗。假成功比做不到危险得多。
 */
describe('校验未通过时不报成功', () => {
  it('动作后表单出现校验错误：回可纠正的失败并带上错误原文', async () => {
    render(`
      <form>
        <input aria-label="密码">
        <div role="alert">密码至少 6 位，需含字母、数字和特殊字符</div>
        <div role="alert">请选择角色</div>
        <button>OK</button>
      </form>
    `)
    const controller = new PageController({ watchRoute: false })
    controller.capture()

    // 索引 1 是「OK」按钮：role="alert" 不可交互，不占索引。
    const result = await toolNamed(controller, 'click')({ index: 1 })

    expect(result.ok).toBe(false)
    expect(result.retryable).toBe(true)
    expect(result.message).toContain('未通过校验')
    expect(result.message).toContain('请选择角色')
    // 页面照给：模型需要它来定位要改的字段。
    expect(result.data).toBeTruthy()
  })

  it('表单干净时照常报成功', async () => {
    render('<form><input aria-label="密码"><button>OK</button></form>')
    const controller = new PageController({ watchRoute: false })
    controller.capture()

    const result = await toolNamed(controller, 'click')({ index: 1 })

    expect(result.ok).toBe(true)
  })

  it('表单外的 role=alert 是成功提示，不当成校验失败', async () => {
    // `.ant-message` 之流同样用 role="alert"，但挂在 body 上、不在任何表单里。
    // 不加这层限制，一次成功的保存会被判成失败——比漏报更糟，因为模型会去重试。
    render(`
      <div role="alert">添加成功</div>
      <form><input aria-label="密码"><button>OK</button></form>
    `)
    const controller = new PageController({ watchRoute: false })
    controller.capture()

    const result = await toolNamed(controller, 'click')({ index: 1 })

    expect(result.ok).toBe(true)
  })
})

describe('只吞可纠正的失败，不吞程序缺陷', () => {
  it('控制器本身仍旧抛 PageActionError，语义没有被结果化掩盖', () => {
    const controller = new PageController({ watchRoute: false })
    expect(() => controller.click(0)).toThrow(PageActionError)
  })

  it('非 PageActionError 照常抛出，不被伪装成模型可纠正的失败', async () => {
    // 让控制器在动作中途炸一个真正的程序错误
    const controller = new PageController({ watchRoute: false })
    controller.click = () => { throw new TypeError('内部缺陷') }

    await expect(toolNamed(controller, 'click')({ index: 0 })).rejects.toThrow(TypeError)
  })
})
