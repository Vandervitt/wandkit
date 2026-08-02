import { describe, expect, it } from 'vitest'
import { EVAL_CATEGORIES, type EvalCategory } from './metrics'
import {
  PAGE_AGENT_SCENARIOS,
  getPageAgentScenario,
  type EvalScenario
} from './scenarios'

const expectedMappings = [
  ['read-data', 'read_data'],
  ['navigation', 'navigation'],
  ['search-filter', 'search_filter'],
  ['form', 'form'],
  ['composite-select', 'composite_select'],
  ['rich-text', 'rich_text'],
  ['validation-recovery', 'validation_recovery'],
  ['async-loading', 'async_loading'],
  ['ask-user', 'ask_user'],
  ['dynamic-dom', 'dynamic_dom']
] as const satisfies readonly (readonly [string, EvalCategory])[]

const expectedTaskKeywords = new Map([
  ['read-data', '1842'],
  ['navigation', '话单查询'],
  ['search-filter', '张三'],
  ['form', '王五'],
  ['composite-select', '管理员'],
  ['rich-text', '季度总结'],
  ['validation-recovery', '手机号'],
  ['async-loading', '共 27 条'],
  ['ask-user', '日期'],
  ['dynamic-dom', '确认']
])

if (false) {
  const scenario = getPageAgentScenario('read-data')
  // @ts-expect-error 场景 ID 只读
  scenario.id = 'changed'
  // @ts-expect-error 场景类别只读
  scenario.category = 'navigation'
  // @ts-expect-error 场景标题只读
  scenario.title = '已修改'
  // @ts-expect-error 场景任务只读
  scenario.task = '已修改'
  // @ts-expect-error 场景成功判据只读
  scenario.expected = '已修改'
}

describe('PAGE_AGENT_SCENARIOS', () => {
  it('定义十个 ID 唯一的评估场景', () => {
    const ids = PAGE_AGENT_SCENARIOS.map(scenario => scenario.id)

    expect(PAGE_AGENT_SCENARIOS).toHaveLength(10)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('类别集合严格等于全部评估类别', () => {
    const categories = PAGE_AGENT_SCENARIOS.map(scenario => scenario.category)

    expect(new Set(categories)).toEqual(new Set(EVAL_CATEGORIES))
    expect(categories).toHaveLength(EVAL_CATEGORIES.length)
  })

  it('ID 与类别逐项准确映射', () => {
    const mappings = PAGE_AGENT_SCENARIOS.map(scenario => [
      scenario.id,
      scenario.category
    ])

    expect(mappings).toEqual(expectedMappings)
  })

  it('标题、任务和成功判据均为非空中文文本并覆盖真实后台任务', () => {
    for (const scenario of PAGE_AGENT_SCENARIOS) {
      const typedScenario: EvalScenario = scenario
      const keyword = expectedTaskKeywords.get(typedScenario.id)

      expect(typedScenario.title.trim()).not.toBe('')
      expect(typedScenario.task.trim()).not.toBe('')
      expect(typedScenario.expected.trim()).not.toBe('')
      expect(typedScenario.title).toMatch(/[\u4e00-\u9fff]/)
      expect(typedScenario.task).toMatch(/[\u4e00-\u9fff]/)
      expect(typedScenario.expected).toMatch(/[\u4e00-\u9fff]/)
      expect(keyword).toBeDefined()
      expect(typedScenario.task).toContain(keyword)
    }
  })

  it('按 ID 返回数组中的同一场景对象', () => {
    for (const scenario of PAGE_AGENT_SCENARIOS) {
      expect(getPageAgentScenario(scenario.id)).toBe(scenario)
    }
  })

  it('未知 ID 抛出包含该 ID 的明确错误', () => {
    expect(() => getPageAgentScenario('missing')).toThrowError(
      '未知网页评估场景: missing'
    )
  })

  it('冻结场景数组及其中每个场景对象', () => {
    expect(Object.isFrozen(PAGE_AGENT_SCENARIOS)).toBe(true)
    for (const scenario of PAGE_AGENT_SCENARIOS) {
      expect(Object.isFrozen(scenario)).toBe(true)
    }

    expect(() => {
      ;(PAGE_AGENT_SCENARIOS as unknown as EvalScenario[]).push({
        id: 'extra',
        category: 'read_data',
        title: '额外场景',
        task: '执行额外后台任务',
        expected: '页面显示任务成功'
      })
    }).toThrow()
    expect(() => {
      ;(PAGE_AGENT_SCENARIOS[0] as unknown as { title: string }).title =
        '已被修改'
    }).toThrow()
  })
})
