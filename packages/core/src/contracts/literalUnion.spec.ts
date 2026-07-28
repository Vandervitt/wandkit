import { describe, expect, expectTypeOf, it } from 'vitest'
import { labelsFromOptions, literalUnionFromOptions } from './literalUnion'

const PATHOLOGICAL_STRING_OPTIONS = [
  { value: '01', label: '前导零' },
  { value: '1', label: '普通数字字符串' }
] as const

describe('literal union contract', () => {
  it('从显式 options 派生 label map，不解析或合并字符串键', () => {
    const labels = labelsFromOptions(PATHOLOGICAL_STRING_OPTIONS)

    expect(labels).toEqual({
      '01': '前导零',
      '1': '普通数字字符串'
    })
    expectTypeOf(labels['01']).toEqualTypeOf<'前导零'>()
    expectTypeOf(labels['1']).toEqualTypeOf<'普通数字字符串'>()
  })

  it("Schema 保留 '01' 与 '1' 的字符串字面量类型", () => {
    const schema = literalUnionFromOptions(PATHOLOGICAL_STRING_OPTIONS)

    expect(schema.anyOf).toEqual([
      expect.objectContaining({ const: '01', description: '01=前导零' }),
      expect.objectContaining({ const: '1', description: '1=普通数字字符串' })
    ])
  })
})
