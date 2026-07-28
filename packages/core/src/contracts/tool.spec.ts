import { Type } from '@sinclair/typebox'
import { describe, expect, it } from 'vitest'
import { buildToolFunctionName, defineReadTool, defineWriteTool } from './tool'

describe('tool contract', () => {
  it('生成稳定且可版本化的函数名', () => {
    expect(buildToolFunctionName('gateway', 'update', 1)).toBe('gateway_update_v1')
  })

  it('读工具与写工具使用不同契约', () => {
    const read = defineReadTool({
      moduleId: 'gateway',
      name: 'query',
      version: 1,
      title: '查询线路',
      description: '查询线路',
      aliases: ['查线路'],
      risk: 'read',
      executionMode: 'global',
      schema: Type.Object({}, { additionalProperties: false }),
      execute: async() => ({ ok: true, message: 'ok' })
    })
    const write = defineWriteTool({
      moduleId: 'gateway',
      name: 'delete',
      version: 1,
      title: '删除线路',
      description: '删除线路',
      aliases: ['删线路'],
      risk: 'destructive',
      executionMode: 'global',
      schema: Type.Object({ gatewayId: Type.Integer() }, { additionalProperties: false }),
      prepare: async(_ctx, input) => ({ title: '删除线路', rows: [], payload: input }),
      execute: async() => ({ ok: true, message: 'ok' })
    })
    expect(read.risk).toBe('read')
    expect(write.risk).toBe('destructive')
  })
})
