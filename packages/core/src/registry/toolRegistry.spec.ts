import { Type } from '@sinclair/typebox'
import type { TSchema } from '@sinclair/typebox'
import { describe, expect, it } from 'vitest'
import type { ModuleDefinition } from '../contracts/module'
import type { ToolDefinition } from '../contracts/tool'
import { defineReadTool, defineWriteTool } from '../contracts/tool'
import { loadDefaults, type WebpackContext } from './autoDiscovery'
import { createToolRegistry } from './toolRegistry'


const gatewayModule: ModuleDefinition = {
  id: 'gateway',
  title: '线路管理',
  description: '查询和管理线路',
  aliases: ['线路'],
  routes: ['Gateway-managemnet'],
  permissions: ['customerInfo:gatewayManagement'],
  prompt: '使用线路工具处理线路需求',
  examples: ['查询线路'],
  formatContext: () => ''
}

const queryTool = defineReadTool({
  moduleId: 'gateway',
  name: 'query',
  version: 1,
  owner: 'gateway',
  lifecycle: { status: 'active' },
  title: '查询线路',
  description: '按条件查询线路',
  aliases: ['查线路'],
  risk: 'read',
  executionMode: 'global',
  schema: Type.Object({
    keyword: Type.Optional(Type.String())
  }, { additionalProperties: false }),
  execute: async() => ({ ok: true, message: 'ok' })
})

const deleteTool = defineWriteTool({
  moduleId: 'gateway',
  name: 'delete',
  version: 1,
  owner: 'gateway',
  lifecycle: { status: 'active' },
  title: '删除线路',
  description: '删除指定线路',
  aliases: ['删线路'],
  risk: 'destructive',
  executionMode: 'global',
  schema: Type.Object({ gatewayId: Type.Integer() }, { additionalProperties: false }),
  prepare: async(_ctx, input) => ({ title: '删除线路', rows: [], payload: input }),
  execute: async() => ({ ok: true, message: 'ok' })
})

function replaceTool(overrides: Record<string, unknown>): ToolDefinition {
  return { ...queryTool, ...overrides } as ToolDefinition
}

describe('Registry', () => {
  it('拒绝重复模块 ID', () => {
    expect(() => createToolRegistry([gatewayModule, gatewayModule], []))
      .toThrow('Duplicate module id: gateway')
  })

  it('拒绝重复稳定函数名', () => {
    expect(() => createToolRegistry([gatewayModule], [queryTool, queryTool]))
      .toThrow('Duplicate tool function name: gateway_query_v1')
  })

  it('拒绝所属模块不存在的工具', () => {
    const unknownModuleTool = replaceTool({ moduleId: 'unknown' })

    expect(() => createToolRegistry([gatewayModule], [unknownModuleTool]))
      .toThrow('Tool references an unregistered module: unknown')
  })

  it('拒绝缺少 owner 或显式生命周期的工具', () => {
    expect(() => createToolRegistry([gatewayModule], [replaceTool({
      owner: '',
      lifecycle: { status: 'active' }
    })])).toThrow('Tool owner must not be empty: gateway_query_v1')

    expect(() => createToolRegistry([gatewayModule], [replaceTool({
      owner: 'gateway',
      lifecycle: undefined
    })])).toThrow('Invalid tool lifecycle: gateway_query_v1')
  })

  it('废弃工具不再暴露，并指向存在的 active 替代工具', () => {
    const active = replaceTool({ owner: 'gateway', lifecycle: { status: 'active' }})
    const deprecated = replaceTool({
      name: 'legacy_query',
      owner: 'gateway',
      lifecycle: { status: 'deprecated', replacement: 'gateway_query_v1' }
    })
    const registry = createToolRegistry([gatewayModule], [deprecated, active])

    expect(registry.getByModule('gateway')).toEqual([active])
    expect(registry.get('gateway_legacy_query_v1')).toBeUndefined()
    expect(registry.toOpenAITools().map(tool => tool.function.name))
      .toEqual(['gateway_query_v1'])
    expect(() => registry.validateInput('gateway_legacy_query_v1', {}))
      .toThrow('Tool is deprecated, use gateway_query_v1')
  })

  it('拒绝没有可用替代工具的废弃声明', () => {
    const deprecated = replaceTool({
      name: 'legacy_query',
      owner: 'gateway',
      lifecycle: { status: 'deprecated', replacement: 'gateway_missing_v1' }
    })

    expect(() => createToolRegistry([gatewayModule], [deprecated]))
      .toThrow('Deprecated tool has no usable replacement: gateway_legacy_query_v1')
  })

  it('废弃截止日期必须使用 YYYY-MM-DD', () => {
    const deprecated = replaceTool({
      name: 'legacy_query',
      owner: 'gateway',
      lifecycle: {
        status: 'deprecated',
        replacement: 'gateway_query_v1',
        sunsetAt: 'tomorrow'
      }
    })
    const active = replaceTool({ owner: 'gateway', lifecycle: { status: 'active' }})

    expect(() => createToolRegistry([gatewayModule], [deprecated, active]))
      .toThrow('Invalid tool sunset date: gateway_legacy_query_v1')
  })

  it('拒绝非法 JSON Schema', () => {
    const invalidSchemaTool = replaceTool({ schema: null as unknown as TSchema })

    expect(() => createToolRegistry([gatewayModule], [invalidSchemaTool]))
      .toThrow('Invalid schema: gateway_query_v1')
  })

  it.each([
    ['prepare', { prepare: undefined }],
    ['execute', { execute: undefined }]
  ])('拒绝写工具缺少 %s', (_name, override) => {
    const invalidWriteTool = { ...deleteTool, ...override } as unknown as ToolDefinition

    expect(() => createToolRegistry([gatewayModule], [invalidWriteTool]))
      .toThrow('Write tools must implement both prepare and execute: gateway_delete_v1')
  })

  it('Schema 校验拒绝额外字段', () => {
    const registry = createToolRegistry([gatewayModule], [queryTool])

    expect(() => registry.validateInput('gateway_query_v1', { unexpected: true }))
      .toThrow('Argument validation failed')
  })

  it('生成按稳定函数名排序的 OpenAI 工具', () => {
    const registry = createToolRegistry([gatewayModule], [queryTool, deleteTool])

    expect(registry.toOpenAITools().map((tool) => tool.function.name))
      .toEqual(['gateway_delete_v1', 'gateway_query_v1'])
    expect(registry.toOpenAITools()[1]).toEqual({
      type: 'function',
      function: {
        name: 'gateway_query_v1',
        description: '按条件查询线路',
        parameters: queryTool.schema
      }
    })
    expect(registry.toOpenAITools()[0].function.description).toMatch(
      /only prepares confirmation content.*never performs the write.*confirmation card/s
    )
    expect(registry.toOpenAITools()[1].function.description).toBe('按条件查询线路')
  })

  it('loadDefaults 按 key 排序并兼容 default 与直接导出', () => {
    const values: Record<string, unknown> = {
      './z.tool.ts': { id: 'z' },
      './a.tool.ts': { default: { id: 'a' }}
    }
    const context = Object.assign(
      (key: string) => values[key],
      { keys: () => ['./z.tool.ts', './a.tool.ts'] }
    )

    expect(loadDefaults<{ id: string }>(context as unknown as WebpackContext))
      .toEqual([{ id: 'a' }, { id: 'z' }])
  })
})
