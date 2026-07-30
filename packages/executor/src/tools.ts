import { Type } from '@sinclair/typebox'
import { defineReadTool, type ToolDefinition } from 'toolairlock'
import { PageActionError, PageController } from './controller'

/**
 * 把可纠正的操作失败转成结果，而不是让它抛出去。
 *
 * 运行时对**抛出**的异常一律归一成「工具运行失败，请稍后重试」并终结整个 Run。
 * 对「索引失效了，请重新读取页面」这种指引来说，这是最坏的处理方式：模型既看不到
 * 该怎么改，也没有下一轮可以改。实测中模型第一步就直接点击（没先读页面），Run 当场
 * 判死——从用户视角看就是「助手什么都没干就说失败了」。
 *
 * 返回 `ok: false` 则会连同原始指引一起回喂给模型，让它自己纠正，这与参数校验失败
 * 的处理方式一致。
 *
 * 只捕获 {@link PageActionError}：真正的程序缺陷仍旧抛出，否则模型会一直重试一个
 * 永远不可能成功的动作，而 bug 被彻底掩盖。
 */
async function guided(
  controller: PageController,
  run: () => void | Promise<void>,
  describe: () => string
): Promise<{ ok: boolean, message: string, data?: string, retryable?: true }> {
  try {
    await run()
    // 成功后**必须**带上执行之后的页面：不带的话模型每做一个动作就得再花一轮读页面，
    // 一次「新建员工」二十来个动作，模型往返直接翻倍。真实接入实测：Run 点了两三下
    // 就被预算掐断，用户看到的是助手做到一半停下来让他「接着点」。
    //
    // 顺带把「索引失效」整类问题消掉：结果里的清单永远是最新的，模型没有机会沿用
    // 上一轮的索引。
    return { ok: true, message: describe(), data: await controller.formatStable() }
  } catch (error) {
    if (error instanceof PageActionError) {
      // retryable 是关键：没有它，`ok: false` 同样会终结整个 Run，指引写得再好也没人看。
      //
      // 失败路径**不带页面**：动作没生效，页面就是模型上一轮已经看过的那份，重复回传
      // 只是白烧 token，还会让历史里堆起多份难以分辨新旧的清单。
      return { ok: false, message: error.message, retryable: true }
    }
    throw error
  }
}

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
      + '只在还没有任何索引时调用它（会话刚开始，或上一步动作失败了）。'
      + '动作成功后会自带最新清单，无需再调用本工具。',
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
    description: '点击指定索引的元素，并返回点击之后的最新页面清单。'
      + '索引取自最近一次返回的清单。',
    schema: Type.Object({
      index: Type.Integer({ description: '元素索引', minimum: 0 })
    }, { additionalProperties: false }),
    execute: async (_ctx, input: { index: number }) => {
      // 名字必须在动作**之前**取：点击往往让元素当场从文档里消失，事后取就是空的。
      const label = controller.label(input.index)
      return guided(
        controller,
        () => controller.click(input.index),
        () => label ? `已点击「${label}」` : `已点击第 ${input.index} 项`
      )
    }
  })

  const inputText = defineReadTool({
    ...base,
    name: 'input',
    version: 1,
    title: '输入文本',
    description: '向指定索引的输入框填入文本（覆盖原有内容），并返回填入之后的最新页面清单。',
    schema: Type.Object({
      index: Type.Integer({ description: '元素索引', minimum: 0 }),
      text: Type.String({ description: '要填入的文本' })
    }, { additionalProperties: false }),
    execute: async (_ctx, input: { index: number, text: string }) => {
      const label = controller.label(input.index)
      return guided(
        controller,
        () => controller.input(input.index, input.text),
        () => label
          ? `已填写「${label}」：${input.text}`
          : `已在第 ${input.index} 项填入：${input.text}`
      )
    }
  })

  const selectOption = defineReadTool({
    ...base,
    name: 'select',
    version: 1,
    title: '选择下拉项',
    description: '在指定索引的下拉框中按可见文本选中一项，并返回选中之后的最新页面清单。'
      + '原生下拉与组件库的下拉（只读输入框 / combobox + 浮层）都用本工具，'
      + '不要用输入工具往只读的下拉框里填字。',
    schema: Type.Object({
      index: Type.Integer({ description: '元素索引', minimum: 0 }),
      option: Type.String({ description: '选项的可见文本' })
    }, { additionalProperties: false }),
    execute: async (_ctx, input: { index: number, option: string }) => {
      const label = controller.label(input.index)
      return guided(
        controller,
        () => controller.select(input.index, input.option),
        () => label
          ? `已把「${label}」选为「${input.option}」`
          : `已选择「${input.option}」`
      )
    }
  })

  const scrollPage = defineReadTool({
    ...base,
    name: 'scroll',
    version: 1,
    title: '滚动',
    description: '滚动页面或某个内部滚动区，并返回滚动之后的最新页面清单。'
      + '清单只覆盖视口附近的元素，要找的东西不在清单里时用本工具滚动。'
      + '清单中标为 scrollable 的元素是内部滚动区，页面滚动到不了，'
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
    execute: async (_ctx, input: { pages?: number, index?: number }) => guided(
      controller,
      () => controller.scroll(input.pages ?? 1, input.index),
      // 滚动对用户是纯粹的内部动作，说清方向即可，不必暴露容器下标。
      () => (input.pages ?? 1) < 0 ? '已向上翻页' : '已向下翻页'
    )
  })

  return [readPage, clickElement, inputText, selectOption, scrollPage]
}
