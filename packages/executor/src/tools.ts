import { Type } from '@sinclair/typebox'
import { defineReadTool, type ToolDefinition } from 'toolairlock'
import { PageController } from './controller'

/**
 * 把页面操作做成**通用原语**，而不是逐个业务能力的工具。
 *
 * 这是「能力去声明化」的落点：接入方声明的是 4 个原语，而不是 N 个业务动作。
 * 声明一次之后，Agent 能做的事等于用户在界面上能做的事——能力不再需要枚举，
 * 也不会因为漏写某个工具而够不到某项功能。
 *
 * 循环形如：读取页面 → 模型挑索引 → 执行 → 再读取。每一步都重新读，因为上一步
 * 的操作很可能已经改变了页面。
 *
 * ⚠ **当前这些原语没有闸门。** 它们的 `risk` 暂时标为 `read`，因为调用之前无从
 * 判断一次点击会造成什么后果——真正的分级要等请求层拦截器接入后，按实际发出的
 * 请求来做（见 `docs/feat_20260728_请求拦截治理/design.md`）。在拦截器落地之前，
 * **不要把这组工具接到生产环境**。
 */
export interface PageToolOptions {
  moduleId: string
  owner: string
  /** 暴露这些原语所需的权限。 */
  permissions?: string[]
  /** 复用同一个控制器实例，索引映射才能在多次调用间保持有效。 */
  controller?: PageController
}

export function createPageTools(options: PageToolOptions): ToolDefinition[] {
  const controller = options.controller ?? new PageController()
  const base = {
    moduleId: options.moduleId,
    owner: options.owner,
    lifecycle: { status: 'active' as const },
    permissions: options.permissions ?? [],
    aliases: [],
    risk: 'read' as const,
    executionMode: 'global' as const
  }

  const readPage = defineReadTool({
    ...base,
    name: 'read',
    version: 1,
    title: '读取当前页面',
    description: '读取当前页面上所有可交互元素，返回带索引的清单。'
      + '每次要操作页面之前都必须先调用它——上一步操作很可能已经改变了页面，'
      + '沿用旧索引会点到错误的元素。',
    schema: Type.Object({}, { additionalProperties: false }),
    execute: async () => {
      const text = controller.format()
      return { ok: true, message: '已读取当前页面', data: text }
    }
  })

  const clickElement = defineReadTool({
    ...base,
    name: 'click',
    version: 1,
    title: '点击元素',
    description: '点击指定索引的元素。索引来自最近一次「读取当前页面」的结果。',
    schema: Type.Object({
      index: Type.Integer({ description: '元素索引', minimum: 0 })
    }, { additionalProperties: false }),
    execute: async (_ctx, input: { index: number }) => {
      controller.click(input.index)
      return { ok: true, message: `已点击 [${input.index}]` }
    }
  })

  const inputText = defineReadTool({
    ...base,
    name: 'input',
    version: 1,
    title: '输入文本',
    description: '向指定索引的输入框填入文本，会覆盖原有内容。',
    schema: Type.Object({
      index: Type.Integer({ description: '元素索引', minimum: 0 }),
      text: Type.String({ description: '要填入的文本' })
    }, { additionalProperties: false }),
    execute: async (_ctx, input: { index: number, text: string }) => {
      controller.input(input.index, input.text)
      return { ok: true, message: `已在 [${input.index}] 填入「${input.text}」` }
    }
  })

  const selectOption = defineReadTool({
    ...base,
    name: 'select',
    version: 1,
    title: '选择下拉项',
    description: '在指定索引的下拉框中按可见文本选中一项。',
    schema: Type.Object({
      index: Type.Integer({ description: '元素索引', minimum: 0 }),
      option: Type.String({ description: '选项的可见文本' })
    }, { additionalProperties: false }),
    execute: async (_ctx, input: { index: number, option: string }) => {
      controller.select(input.index, input.option)
      return { ok: true, message: `已选择「${input.option}」` }
    }
  })

  const scrollPage = defineReadTool({
    ...base,
    name: 'scroll',
    version: 1,
    title: '滚动',
    description: '滚动页面或某个内部滚动区。'
      + '读取页面只返回视口附近的元素，要找的东西不在清单里时先滚动再重新读取。'
      + '快照中标为 scrollable 的元素是内部滚动区，页面滚动到不了，'
      + '需要把它的索引传给 index。',
    schema: Type.Object({
      pages: Type.Optional(Type.Number({
        description: '滚动几屏，负数向上，缺省 1'
      })),
      index: Type.Optional(Type.Integer({
        description: '内部滚动区的元素索引；缺省滚动整个页面',
        minimum: 0
      }))
    }, { additionalProperties: false }),
    execute: async (_ctx, input: { pages?: number, index?: number }) => {
      controller.scroll(input.pages ?? 1, input.index)
      return {
        ok: true,
        message: input.index === undefined
          ? `已滚动页面 ${input.pages ?? 1} 屏`
          : `已滚动 [${input.index}] ${input.pages ?? 1} 屏`
      }
    }
  })

  return [readPage, clickElement, inputText, selectOption, scrollPage]
}
