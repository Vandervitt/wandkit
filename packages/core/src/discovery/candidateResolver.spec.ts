import { describe, expect, it } from 'vitest'
import type { ModuleDefinition } from '../contracts/module'
import {
  filterAuthorizedModules,
  filterAuthorizedTools,
  hasPermission
} from './permissionFilter'
import { resolveCandidates } from './candidateResolver'
import { MAX_CANDIDATE_MODULES } from './budget'

function createModule(
  id: string,
  overrides: Partial<ModuleDefinition> = {}
): ModuleDefinition {
  return {
    id,
    title: id,
    description: `${id} 功能`,
    aliases: [],
    routes: [],
    permissions: [],
    prompt: `${id} prompt`,
    examples: [],
    formatContext: () => '',
    ...overrides
  }
}

const modules: ModuleDefinition[] = [
  createModule('alias', { aliases: ['账单'], permissions: ['billing:invoice:list'] }),
  createModule('route', { routes: ['Customer-list'] }),
  createModule('activated'),
  createModule('previous'),
  createModule('fuse', {
    title: '客户账单查询',
    description: '查询客户的历史账单',
    examples: ['查客户账单']
  })
]

describe('权限过滤', () => {
  it('模块声明任一权限命中即允许，空声明不额外限制', () => {
    expect(hasPermission([], [])).toBe(true)
    expect(hasPermission(['a:b:c', 'billing:invoice:list'], ['billing:invoice:list'])).toBe(true)
    expect(hasPermission(['billing:invoice:list'], ['customer:list:view'])).toBe(false)
  })

  it('支持项目通配权限', () => {
    expect(hasPermission(['billing:invoice:list'], ['*:*:*'])).toBe(true)
  })

  it('工具级权限也在暴露前过滤', () => {
    const tools = [
      { name: 'public', permissions: [] },
      { name: 'billing', permissions: ['billing:invoice:list'] }
    ]

    expect(filterAuthorizedTools(tools, []).map(tool => tool.name)).toEqual(['public'])
  })

  it('在候选检索前剔除无权限模块', () => {
    expect(filterAuthorizedModules(modules, []).map(module => module.id))
      .not.toContain('alias')
    expect(resolveCandidates({
      text: '账单',
      routeName: 'Other-route',
      modules: [modules[0]],
      permissions: []
    })).toEqual([])
  })
})

describe('候选模块解析', () => {
  it('固定使用显式别名、已激活、上轮调用、当前路由、Fuse 的优先级', () => {
    expect(resolveCandidates({
      text: '查客户账单',
      routeName: 'Customer-list',
      modules,
      permissions: ['billing:invoice:list'],
      activatedModuleIds: ['activated'],
      previousModuleIds: ['previous']
    })).toEqual(['alias', 'activated'])

    expect(resolveCandidates({
      text: '查客户账单',
      modules: modules.filter(module => module.id !== 'alias'),
      permissions: [],
      activatedModuleIds: ['activated'],
      previousModuleIds: ['previous']
    })).toEqual(['activated', 'previous'])

    expect(resolveCandidates({
      text: '查客户账单',
      modules: modules.filter(module => ['previous', 'fuse'].includes(module.id)),
      permissions: [],
      previousModuleIds: ['previous']
    })).toEqual(['previous', 'fuse'])
  })

  it('最多激活两个业务模块', () => {
    expect(resolveCandidates({
      text: '查客户账单',
      routeName: 'Customer-list',
      modules,
      permissions: ['billing:invoice:list'],
      activatedModuleIds: ['activated'],
      previousModuleIds: ['previous']
    })).toEqual(['alias', 'activated'])
  })

  it('上一轮涉及的模块优先于当前路由，多轮追问不丢失正在操作的模块', () => {
    const taskModule = createModule('task')
    const cdrModule = createModule('cdr', { routes: ['BillInquiry'] })

    // 上一轮在操作 task；当前停留在话单页(BillInquiry)；本轮输入不含任务关键词
    expect(resolveCandidates({
      text: '打开对应的页面并展示第三页',
      routeName: 'BillInquiry',
      modules: [taskModule, cdrModule],
      permissions: [],
      previousModuleIds: ['task']
    })).toEqual(['task', 'cdr'])
  })

  it('Fuse 同分时按模块 ID 稳定排序', () => {
    const sameScoreModules = [
      createModule('zebra', { title: '报表查询' }),
      createModule('alpha', { title: '报表查询' })
    ]

    expect(resolveCandidates({
      text: '报表查询',
      modules: sameScoreModules,
      permissions: []
    })).toEqual(['alpha', 'zebra'])
  })
})

describe('全局可达：任何模块都不该被措辞或路由锁在门外', () => {
  const modules = [
    createModule('cdr', { title: '话单查询', aliases: ['话单'], routes: ['Bill-inquiry'] }),
    createModule('customer', { title: '客户管理', aliases: ['客户'], routes: ['Customer-list'] }),
    createModule('gateway', { title: '线路管理', aliases: ['线路'], routes: ['Gateway-list'] }),
    createModule('task', { title: '任务管理', aliases: ['任务'], routes: ['Task-list'] })
  ]

  it('一个信号都没命中时，仍返回全部有权限的模块', () => {
    // 「这通电话是谁打的」不含任何别名，用户又停在无关页面。收窄到空集意味着
    // Copilot 在这种时候彻底哑火——而这恰恰是用户最需要它的时候。
    const candidates = resolveCandidates({
      text: '这通电话是谁打的',
      routeName: 'Sales-dashboard',
      modules,
      permissions: [],
      limit: 10
    })

    expect(candidates).toHaveLength(4)
    expect(candidates).toEqual(expect.arrayContaining(['cdr', 'customer', 'gateway', 'task']))
  })

  it('兜底进来的模块排在所有命中信号的模块之后', () => {
    const candidates = resolveCandidates({
      text: '查一下话单',
      routeName: 'Gateway-list',
      modules,
      permissions: [],
      limit: 10
    })

    // 别名命中的 cdr 第一，当前路由的 gateway 第二，其余按 id 兜底
    expect(candidates.slice(0, 2)).toEqual(['cdr', 'gateway'])
    expect(candidates).toHaveLength(4)
  })

  it('兜底不会绕过权限：无权模块永远不出现', () => {
    const guarded = [
      createModule('open', { permissions: [] }),
      createModule('secret', { permissions: ['admin:secret:read'] })
    ]

    const candidates = resolveCandidates({
      text: '随便问点什么',
      modules: guarded,
      permissions: [],
      limit: 10
    })

    expect(candidates).toEqual(['open'])
  })

  it('limit 缺省时保持原有的收窄行为，不影响既有接入方', () => {
    const candidates = resolveCandidates({
      text: '这通电话是谁打的',
      routeName: 'Sales-dashboard',
      modules,
      permissions: []
    })

    expect(candidates).toHaveLength(MAX_CANDIDATE_MODULES)
  })
})
