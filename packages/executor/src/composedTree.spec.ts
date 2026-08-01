import { beforeEach, describe, expect, it } from 'vitest'
import {
  closestComposed,
  composedChildNodes,
  composedContains,
  composedElements,
  composedParent,
  composedTextContent,
  treeScope
} from './composedTree'

beforeEach(() => {
  document.body.replaceChildren()
})

describe('composedChildNodes', () => {
  it('open Shadow Root 替代 Host 的 light DOM 子节点', () => {
    const host = document.createElement('div')
    const light = document.createElement('button')
    light.id = 'light'
    host.append(light)
    const shadow = host.attachShadow({ mode: 'open' })
    const inside = document.createElement('button')
    inside.id = 'inside'
    shadow.append(inside)

    expect(composedChildNodes(host)).toEqual([inside])
  })
})

describe('composedElements', () => {
  it('按 Host 所在位置展开 open Shadow Root，并保持普通元素顺序', () => {
    const before = document.createElement('button')
    before.id = 'before'
    const host = document.createElement('div')
    host.id = 'host'
    const shadow = host.attachShadow({ mode: 'open' })
    const inside = document.createElement('button')
    inside.id = 'inside'
    shadow.append(inside)
    const after = document.createElement('button')
    after.id = 'after'
    document.body.append(before, host, after)

    expect(Array.from(composedElements(document), element => element.id))
      .toEqual(['before', 'host', 'inside', 'after'])
  })

  it('递归展开嵌套 open Shadow Root', () => {
    const outer = document.createElement('div')
    outer.id = 'outer'
    const outerRoot = outer.attachShadow({ mode: 'open' })
    const inner = document.createElement('div')
    inner.id = 'inner'
    const innerRoot = inner.attachShadow({ mode: 'open' })
    const button = document.createElement('button')
    button.id = 'deep'
    innerRoot.append(button)
    outerRoot.append(inner)
    document.body.append(outer)

    expect(Array.from(composedElements(document), element => element.id))
      .toEqual(['outer', 'inner', 'deep'])
  })
})

describe('slot composed children', () => {
  it('在 slot 位置展开分发元素，排除未分发 light DOM 且不重复', () => {
    const host = document.createElement('div')
    const root = host.attachShadow({ mode: 'open' })
    const before = document.createElement('span')
    before.id = 'shadow-before'
    const slot = document.createElement('slot')
    slot.name = 'action'
    const after = document.createElement('span')
    after.id = 'shadow-after'
    root.append(before, slot, after)

    const assigned = document.createElement('button')
    assigned.id = 'assigned'
    assigned.slot = 'action'
    const unassigned = document.createElement('button')
    unassigned.id = 'unassigned'
    unassigned.slot = 'missing'
    host.append(assigned, unassigned)
    document.body.append(host)

    expect(Array.from(composedElements(document), element => element.id))
      .toEqual(['', 'shadow-before', '', 'assigned', 'shadow-after'])
  })

  it('没有分发节点时遍历 fallback', () => {
    const host = document.createElement('div')
    const root = host.attachShadow({ mode: 'open' })
    const slot = document.createElement('slot')
    const fallback = document.createElement('button')
    fallback.id = 'fallback'
    slot.append(fallback)
    root.append(slot)
    document.body.append(host)

    expect(Array.from(composedElements(document), element => element.id))
      .toContain('fallback')
  })

  it('只有文本被分发时不启用 fallback，并读取 composed text', () => {
    const host = document.createElement('div')
    host.textContent = '保存'
    const root = host.attachShadow({ mode: 'open' })
    const button = document.createElement('button')
    const slot = document.createElement('slot')
    slot.textContent = '默认文字'
    button.append(slot)
    root.append(button)
    document.body.append(host)

    expect(composedTextContent(button)).toBe('保存')
    expect(composedTextContent(slot)).toBe('保存')
  })

  it('closed Shadow Root 保持不可见', () => {
    const host = document.createElement('div')
    const root = host.attachShadow({ mode: 'closed' })
    const secret = document.createElement('button')
    secret.id = 'closed-button'
    root.append(secret)
    document.body.append(host)

    expect(Array.from(composedElements(document), element => element.id))
      .not.toContain('closed-button')
  })
})

describe('composed ancestry and scope', () => {
  it('slot、Shadow Root 与 Host 组成 composed 祖先链', () => {
    const host = document.createElement('section')
    host.id = 'host'
    const root = host.attachShadow({ mode: 'open' })
    const slot = document.createElement('slot')
    slot.id = 'slot'
    const child = document.createElement('button')
    child.id = 'child'
    host.append(child)
    root.append(slot)
    document.body.append(host)

    expect(composedParent(child)).toBe(slot)
    expect(composedParent(slot)).toBe(host)
    expect(composedContains(host, child)).toBe(true)
    expect(closestComposed(child, '#host')).toBe(host)
    expect(treeScope(slot)).toBe(root)
    expect(treeScope(child)).toBe(document)
  })

  it('单个异常 Host 只跳过自己的内部，不阻断后续兄弟', () => {
    const broken = document.createElement('div')
    Object.defineProperty(broken, 'shadowRoot', {
      get: () => { throw new Error('denied') }
    })
    const skipped = document.createElement('button')
    skipped.id = 'skipped'
    broken.append(skipped)
    const after = document.createElement('button')
    after.id = 'after'
    document.body.append(broken, after)

    expect(Array.from(composedElements(document), element => element.id))
      .toEqual(['', 'after'])
  })
})
