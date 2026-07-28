import { Type } from '@sinclair/typebox'
import { describe, expect, it } from 'vitest'
import type { ModuleDefinition } from '../contracts/module'
import { defineReadTool, type ToolDefinition } from '../contracts/tool'
import { collectModuleContractIssues } from './moduleContract'

function createModule(overrides: Partial<ModuleDefinition> = {}): ModuleDefinition {
  return {
    id: 'sample',
    title: '示例模块',
    description: '用于契约测试',
    aliases: ['示例'],
    routes: ['SamplePage'],
    permissions: ['sample:item:list'],
    prompt: '只能调用真实工具',
    examples: ['查询示例'],
    formatContext: () => '',
    ...overrides
  }
}

function createTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return defineReadTool({
    moduleId: 'sample',
    name: 'query',
    version: 1,
    owner: 'sample',
    lifecycle: { status: 'active' },
    title: '查询示例',
    description: '查询真实示例',
    aliases: ['查示例'],
    permissions: ['sample:item:list'],
    risk: 'read',
    executionMode: 'hybrid',
    schema: Type.Object({}, { additionalProperties: false }),
    execute: async() => ({ ok: true, message: 'ok' }),
    ...overrides
  } as any)
}

describe('Module Contract Suite', () => {
  it('拒绝模块没有任何工具', () => {
    expect(collectModuleContractIssues({ modules: [createModule()], tools: [] }))
      .toContainEqual(expect.objectContaining({ code: 'MODULE_WITHOUT_TOOL' }))
  })

  it('拒绝工具声明模块之外的权限', () => {
    const issues = collectModuleContractIssues({
      modules: [createModule()],
      tools: [createTool({ permissions: ['admin:secret:list'] })]
    })

    expect(issues).toContainEqual(expect.objectContaining({ code: 'TOOL_PERMISSION_OUTSIDE_MODULE' }))
  })

  it('拒绝允许额外字段的 Schema 和非法版本', () => {
    const issues = collectModuleContractIssues({
      modules: [createModule()],
      tools: [createTool({
        version: 0,
        schema: Type.Object({ keyword: Type.String() })
      })]
    })

    expect(issues.map(issue => issue.code)).toEqual(expect.arrayContaining([
      'TOOL_VERSION_INVALID',
      'TOOL_SCHEMA_ADDITIONAL_PROPERTIES'
    ]))
  })

  it('拒绝缺少 owner 和生命周期的工具', () => {
    const issues = collectModuleContractIssues({
      modules: [createModule()],
      tools: [createTool({ owner: '', lifecycle: undefined } as any)]
    })

    expect(issues.map(issue => issue.code)).toEqual(expect.arrayContaining([
      'TOOL_OWNER_INVALID',
      'TOOL_LIFECYCLE_INVALID'
    ]))
  })
})
