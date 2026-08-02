import type { EvalCategory } from './metrics'

export interface EvalScenario {
  id: string
  category: EvalCategory
  title: string
  task: string
  expected: string
}

export const PAGE_AGENT_SCENARIOS = Object.freeze(
  [
    Object.freeze({
      id: 'read-data',
      category: 'read_data',
      title: '读取运营概览数据',
      task: '读取运营概览页显示的今日订单数“1842”，并准确回复该数值。',
      expected: '回答明确给出今日订单数为 1842，且与页面展示一致。'
    }),
    Object.freeze({
      id: 'navigation',
      category: 'navigation',
      title: '进入话单查询页面',
      task: '从后台首页进入“话单查询”页面。',
      expected: '页面成功切换到话单查询，标题和查询区域均已显示。'
    }),
    Object.freeze({
      id: 'search-filter',
      category: 'search_filter',
      title: '搜索指定用户',
      task: '在用户管理列表中搜索“张三”，只查看匹配的用户记录。',
      expected: '列表完成筛选并显示张三的用户记录，不再展示无关用户。'
    }),
    Object.freeze({
      id: 'form',
      category: 'form',
      title: '创建新员工',
      task: '在员工管理中创建姓名为“王五”的新员工，并提交表单。',
      expected: '页面提示创建成功，员工列表中可以看到王五的记录。'
    }),
    Object.freeze({
      id: 'composite-select',
      category: 'composite_select',
      title: '选择员工角色',
      task: '编辑员工王五，通过角色选择框将其角色设为“管理员”并保存。',
      expected: '保存成功后，王五的角色在详情或列表中显示为管理员。'
    }),
    Object.freeze({
      id: 'rich-text',
      category: 'rich_text',
      title: '填写公告富文本',
      task: '在公告编辑页的正文中写入“季度总结”，并保存公告。',
      expected: '公告保存成功，正文区域完整显示季度总结。'
    }),
    Object.freeze({
      id: 'validation-recovery',
      category: 'validation_recovery',
      title: '修正手机号校验错误',
      task: '创建联系人赵六，手机号触发格式校验后改为“13800138000”，再提交表单。',
      expected: '手机号校验错误消失，联系人赵六使用修正后的手机号创建成功。'
    }),
    Object.freeze({
      id: 'async-loading',
      category: 'async_loading',
      title: '等待异步列表加载',
      task: '打开操作日志列表，等待数据加载完成后回复页面显示的“共 27 条”。',
      expected: '回答明确给出共 27 条，且页面列表已结束加载并显示总数。'
    }),
    Object.freeze({
      id: 'ask-user',
      category: 'ask_user',
      title: '追问缺失的日期范围',
      task: '为用户导出业务报表，但用户没有提供日期范围；先向用户追问日期。',
      expected: '回答明确询问需要导出的开始日期和结束日期，未自行猜测或提交导出。'
    }),
    Object.freeze({
      id: 'dynamic-dom',
      category: 'dynamic_dom',
      title: '处理动态确认弹窗',
      task: '在任务列表删除“过期草稿”，等待动态弹窗出现后点击新出现的“确认”。',
      expected: '确认弹窗关闭，页面提示删除成功，列表中不再显示过期草稿。'
    })
  ] as const satisfies readonly EvalScenario[]
)

export function getPageAgentScenario(id: string): EvalScenario {
  const scenario = PAGE_AGENT_SCENARIOS.find(item => item.id === id)
  if (!scenario) {
    throw new Error(`未知网页评估场景: ${id}`)
  }
  return scenario
}
