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
      ok: boolean, message: string
    }>)({}, input)
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
