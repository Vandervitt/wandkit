# Shadow DOM 元素捕获 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让页面快照和页面控制器按 composed tree 捕获并操作 open Shadow DOM、嵌套 Shadow Root 与 slot 分发内容，同时保持顺序、层级、可访问名和索引契约。

**Architecture:** 新增私有 `composedTree.ts` 作为 composed child nodes、深度优先遍历、跨边界祖先和 Tree Scope 的单一事实源。`snapshot.ts` 用它替换单一 DOM Tree 扫描与祖先判断，`controller.ts` 用同一遍历补齐整页辅助扫描；公开 API 与动作参数不变。

**Tech Stack:** TypeScript、DOM/Shadow DOM APIs、Vitest、jsdom、tsup

---

### Task 1: 建立 composed tree 私有基础模块

**Files:**
- Create: `packages/executor/src/composedTree.ts`
- Create: `packages/executor/src/composedTree.spec.ts`

- [x] **Step 1: 写普通 DOM、open/nested Shadow Root 的失败测试**

创建 `packages/executor/src/composedTree.spec.ts`，先导入尚不存在的模块：

```ts
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
```

- [x] **Step 2: 写 slot 分发、fallback、纯文本和 closed Root 的失败测试**

在同一文件补充：

```ts
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
```

- [x] **Step 3: 写跨边界祖先、Tree Scope 与异常降级失败测试**

```ts
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
```

- [x] **Step 4: 运行测试并确认 RED**

Run:

```bash
npx vitest run packages/executor/src/composedTree.spec.ts
```

Expected: FAIL，原因是 `./composedTree` 模块尚不存在；不能是测试语法或 jsdom 初始化错误。

- [x] **Step 5: 实现 composed child nodes 与遍历**

创建 `packages/executor/src/composedTree.ts`：

```ts
const ELEMENT_NODE = 1
const TEXT_NODE = 3
const DOCUMENT_NODE = 9

function childNodesOf(root: ParentNode): readonly Node[] {
  try {
    return Array.from(root.childNodes)
  } catch (_error) {
    return []
  }
}

function shadowRootOf(element: Element): ShadowRoot | null | undefined {
  try {
    return element.shadowRoot
  } catch (_error) {
    return undefined
  }
}

export function composedChildNodes(root: ParentNode): readonly Node[] {
  if (root.nodeType === ELEMENT_NODE && (root as Element).localName === 'slot') {
    try {
      const assigned = (root as HTMLSlotElement).assignedNodes({ flatten: true })
      if (assigned.length > 0) return assigned
    } catch (_error) {
      return []
    }
    return childNodesOf(root)
  }

  if (root.nodeType === ELEMENT_NODE) {
    const shadow = shadowRootOf(root as Element)
    if (shadow === undefined) return []
    if (shadow) return childNodesOf(shadow)
  }
  return childNodesOf(root)
}

export function* composedElements(root: ParentNode): Iterable<Element> {
  const seen = new WeakSet<Node>()

  function* visit(parent: ParentNode): Iterable<Element> {
    for (const node of composedChildNodes(parent)) {
      if (seen.has(node)) continue
      seen.add(node)
      if (node.nodeType !== ELEMENT_NODE) continue
      const element = node as Element
      yield element
      yield* visit(element)
    }
  }

  yield* visit(root)
}

export function composedTextContent(root: ParentNode): string {
  const seen = new WeakSet<Node>()

  function collect(parent: ParentNode): string {
    return composedChildNodes(parent).map(node => {
      if (seen.has(node)) return ''
      seen.add(node)
      if (node.nodeType === TEXT_NODE) return node.textContent ?? ''
      return node.nodeType === ELEMENT_NODE ? collect(node as Element) : ''
    }).join('')
  }

  return collect(root)
}
```

- [x] **Step 6: 实现 composed 祖先与 Tree Scope**

在同一文件追加：

```ts
export function composedParent(element: Element): Element | null {
  const assigned = (element as Element & { assignedSlot?: HTMLSlotElement | null }).assignedSlot
  if (assigned) return assigned
  if (element.parentElement) return element.parentElement
  const root = element.getRootNode()
  return root.nodeType !== DOCUMENT_NODE && 'host' in root
    ? (root as ShadowRoot).host
    : null
}

export function composedContains(ancestor: Element, descendant: Element): boolean {
  let current: Element | null = descendant
  while (current) {
    if (current === ancestor) return true
    current = composedParent(current)
  }
  return false
}

export function closestComposed(element: Element, selector: string): Element | null {
  let current: Element | null = element
  while (current) {
    if (current.matches(selector)) return current
    current = composedParent(current)
  }
  return null
}

export function treeScope(element: Element): Document | ShadowRoot {
  const root = element.getRootNode()
  if (root.nodeType === DOCUMENT_NODE) return root as Document
  if ('host' in root) return root as ShadowRoot
  return element.ownerDocument
}
```

- [x] **Step 7: 运行 composed tree 测试并确认 GREEN**

Run:

```bash
npx vitest run packages/executor/src/composedTree.spec.ts
```

Expected: PASS，所有遍历、slot、文本、closed Root、祖先和降级用例通过。

- [x] **Step 8: 提交基础模块**

提交前重新检查分支并暂存明确文件：

```bash
test "$(git branch --show-current)" = "feat_20260801_ShadowDOM元素捕获"
git add packages/executor/src/composedTree.ts packages/executor/src/composedTree.spec.ts
git commit -m "feat: 新增 composed tree 遍历"
```

### Task 2: 页面快照接入 composed tree

**Files:**
- Modify: `packages/executor/src/snapshot.ts`
- Modify: `packages/executor/src/snapshot.spec.ts`
- Modify: `packages/executor/src/crossFramework.spec.ts`

- [x] **Step 1: 将既有 P2 用例改成 open Root 正向红测，并增加 closed Root 边界**

在 `packages/executor/src/crossFramework.spec.ts` 修改 Shadow DOM 分组：

```ts
it('默认穿透 open Shadow Root 并收录内部元素', () => {
  render('<div id="host"></div>')
  const host = document.getElementById('host') as HTMLElement
  const shadow = host.attachShadow({ mode: 'open' })
  const button = document.createElement('button')
  button.textContent = '影子按钮'
  shadow.appendChild(button)

  expect(capturePage().elements.map(element => element.name)).toContain('影子按钮')
})

it('closed Shadow Root 保持不可见', () => {
  render('<div id="closed-host"></div>')
  const host = document.getElementById('closed-host') as HTMLElement
  const shadow = host.attachShadow({ mode: 'closed' })
  const button = document.createElement('button')
  button.textContent = '关闭影子按钮'
  shadow.appendChild(button)

  expect(capturePage().elements.map(element => element.name))
    .not.toContain('关闭影子按钮')
})
```

- [x] **Step 2: 写混排顺序、连续索引、层级和 slot 文本红测**

在 `packages/executor/src/snapshot.spec.ts` 增加：

```ts
describe('capturePage —— composed tree', () => {
  it('普通 DOM、影子树和 slot 内容按渲染顺序共享连续索引', () => {
    const before = document.createElement('button')
    before.textContent = '之前'
    const host = document.createElement('section')
    const root = host.attachShadow({ mode: 'open' })
    const group = document.createElement('div')
    group.setAttribute('role', 'button')
    group.setAttribute('aria-label', '影子组')
    const slot = document.createElement('slot')
    slot.name = 'action'
    group.append(slot)
    root.append(group)
    const assigned = document.createElement('button')
    assigned.slot = 'action'
    assigned.textContent = '分发按钮'
    host.append(assigned)
    const after = document.createElement('button')
    after.textContent = '之后'
    document.body.append(before, host, after)

    expect(capturePage().elements.map(element => ({
      index: element.index,
      name: element.name,
      depth: element.depth
    }))).toEqual([
      { index: 0, name: '之前', depth: 0 },
      { index: 1, name: '影子组', depth: 0 },
      { index: 2, name: '分发按钮', depth: 1 },
      { index: 3, name: '之后', depth: 0 }
    ])
  })

  it('slot 分发文本成为内部按钮的可访问名', () => {
    const host = document.createElement('div')
    host.textContent = '保存'
    const root = host.attachShadow({ mode: 'open' })
    const button = document.createElement('button')
    button.append(document.createElement('slot'))
    root.append(button)
    document.body.append(host)

    expect(capturePage().elements[0]).toMatchObject({ role: 'button', name: '保存' })
  })
})
```

- [x] **Step 3: 写隐藏 Host、Shadow Tree Scope 名称与语义筛选红测**

```ts
it('隐藏 Host 会隐藏 open Shadow Root 内部元素', () => {
  const host = document.createElement('div')
  host.hidden = true
  const root = host.attachShadow({ mode: 'open' })
  const button = document.createElement('button')
  button.textContent = '不可见'
  root.append(button)
  document.body.append(host)

  expect(capturePage().elements).toHaveLength(0)
})

it('Shadow Root 内 aria-labelledby 与 label[for] 在本 Tree Scope 解析', () => {
  const host = document.createElement('div')
  const root = host.attachShadow({ mode: 'open' })
  root.innerHTML = `
    <span id="button-name">影子导出</span>
    <button aria-labelledby="button-name">GO</button>
    <label for="keyword">关键词</label>
    <input id="keyword">
  `
  document.body.append(host)

  expect(capturePage().elements.map(element => element.name))
    .toEqual(['影子导出', '关键词'])
})

it('关闭 cursor 推断时仍穿透影子树收录语义控件', () => {
  const host = document.createElement('div')
  const root = host.attachShadow({ mode: 'open' })
  root.innerHTML = '<button>语义按钮</button><div style="cursor:pointer">推断按钮</div>'
  document.body.append(host)

  expect(capturePage(document, { detectClickableCursor: false }).elements.map(e => e.name))
    .toEqual(['语义按钮'])
})
```

- [x] **Step 4: 运行目标测试并确认 RED**

Run:

```bash
npx vitest run packages/executor/src/snapshot.spec.ts packages/executor/src/crossFramework.spec.ts
```

Expected: 新增 open Shadow DOM、顺序、slot 文本、隐藏 Host 和 Tree Scope 用例失败；closed Root 用例可以已通过。

- [x] **Step 5: 接入 composed tree 遍历与层级**

在 `packages/executor/src/snapshot.ts` 导入：

```ts
import {
  closestComposed,
  composedChildNodes,
  composedContains,
  composedElements,
  composedParent,
  composedTextContent,
  treeScope
} from './composedTree'
```

把候选集合与遍历改为：

```ts
const candidates = composedElements(root)

for (const element of candidates) {
  if (!detectCursor && !element.matches(CANDIDATE_SELECTOR)) continue
  if (!isVisible(element, cache, layout)) continue
  while (ancestors.length > 0 &&
    !composedContains(ancestors[ancestors.length - 1].element, element)) {
    ancestors.pop()
  }
  if (capture(element)) continue
  // 保留后续正文过滤与追加逻辑
}
```

不要分两次生成快照与真实元素列表；两者仍在同一遍历中同步追加。

- [x] **Step 6: 接入 composed text 与 Tree Scope 名称解析**

把直接文本函数改为：

```ts
function directText(element: Element): string {
  return composedChildNodes(element)
    .filter(node => node.nodeType === 3)
    .map(node => node.textContent ?? '')
    .join('')
}
```

`accessibleName()` 的子树文本使用 `composedTextContent(element)`；`aria-labelledby` 与
`label[for]` 使用 `treeScope(element)`：

```ts
function elementByIdInScope(element: Element, id: string): Element | null {
  const scope = treeScope(element)
  return scope.nodeType === 9
    ? (scope as Document).getElementById(id)
    : (scope as ShadowRoot).getElementById(id)
}

function queryInScope(element: Element, selector: string): Element | null {
  return treeScope(element).querySelector(selector)
}
```

行上下文中读取行和首格文本时改用 `composedTextContent()`。

- [x] **Step 7: 把祖先与后代过滤切换到 composed 语义**

逐项替换：

- `element.closest('[hidden]')` / `element.closest('[aria-hidden="true"]')` → `closestComposed`。
- `parentElement` 样式上溯 → `composedParent`。
- `hasOwnEventHandler()` 的祖先循环 → `composedParent`。
- `hasFilteredInteractiveAncestor()` 的祖先循环 → `composedParent`。
- cursor 语义叶子祖先判断 → `composedParent` 循环。
- `hasInteractiveDescendant()` → 遍历 `composedElements(element)`。
- direct child cursor 判断 → `composedChildNodes(element)` 中的 Element。
- 行容器查找 → 从 `composedParent(element)` 开始调用 `closestComposed`。
- 遮挡命中中的 `contains()` 双向关系 → `composedContains()` 双向关系。

保留 `isLabelDecoration()` 的原生 `closest('label')`，避免跨 Tree Scope 错建 label 关系。

- [x] **Step 8: 运行快照测试并确认 GREEN**

Run:

```bash
npx vitest run packages/executor/src/composedTree.spec.ts packages/executor/src/snapshot.spec.ts packages/executor/src/crossFramework.spec.ts
```

Expected: 三个测试文件全部通过，既有普通 DOM 用例不回归。

- [x] **Step 9: 提交快照集成**

```bash
test "$(git branch --show-current)" = "feat_20260801_ShadowDOM元素捕获"
git add packages/executor/src/snapshot.ts packages/executor/src/snapshot.spec.ts packages/executor/src/crossFramework.spec.ts
git commit -m "feat: 页面快照穿透 open Shadow DOM"
```

### Task 3: 页面控制器操作与辅助扫描支持 Shadow DOM

**Files:**
- Modify: `packages/executor/src/controller.ts`
- Modify: `packages/executor/src/controller.spec.ts`

- [x] **Step 1: 写点击、输入、选择和索引失效红测**

在 `packages/executor/src/controller.spec.ts` 增加：

```ts
describe('PageController —— Shadow DOM 动作', () => {
  it('按连续索引点击 open Shadow Root 内按钮', () => {
    const host = document.createElement('div')
    const root = host.attachShadow({ mode: 'open' })
    const button = document.createElement('button')
    button.textContent = '影子操作'
    const clicked = vi.fn()
    button.addEventListener('click', clicked)
    root.append(button)
    document.body.append(host)
    const controller = new PageController()
    const snapshot = controller.capture()

    controller.click(snapshot.elements.findIndex(element => element.name === '影子操作'))

    expect(clicked).toHaveBeenCalledTimes(1)
  })

  it('输入与原生选择操作影子树中的真实控件', async () => {
    const host = document.createElement('div')
    const root = host.attachShadow({ mode: 'open' })
    root.innerHTML = `
      <input aria-label="关键词">
      <select aria-label="状态"><option value="on">启用</option></select>
    `
    document.body.append(host)
    const input = root.querySelector('input') as HTMLInputElement
    const select = root.querySelector('select') as HTMLSelectElement
    const changed = vi.fn()
    input.addEventListener('change', changed)
    select.addEventListener('change', changed)
    const controller = new PageController()
    const snapshot = controller.capture()

    controller.input(snapshot.elements.findIndex(element => element.name === '关键词'), '客户')
    await controller.select(snapshot.elements.findIndex(element => element.name === '状态'), '启用')

    expect(input.value).toBe('客户')
    expect(select.value).toBe('on')
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it('Host 移除后影子树旧索引失效', () => {
    const host = document.createElement('div')
    const root = host.attachShadow({ mode: 'open' })
    const button = document.createElement('button')
    button.textContent = '即将移除'
    root.append(button)
    document.body.append(host)
    const controller = new PageController()
    controller.capture()
    host.remove()

    expect(() => controller.click(0)).toThrow(/已不在当前文档/)
  })
})
```

- [x] **Step 2: 写影子树校验错误与最大滚动容器红测**

在测试文件现有的“滚动” `describe` 内复用 `makeScrollable` 夹具，增加滚动用例；
表单校验用例仍放在现有表单校验分组：

```ts
it('识别 open Shadow Root 内的表单校验错误', () => {
  const host = document.createElement('div')
  const root = host.attachShadow({ mode: 'open' })
  root.innerHTML = '<form><div role="alert">名称不能为空</div></form>'
  document.body.append(host)

  expect(new PageController().validationErrors()).toEqual(['名称不能为空'])
})

it('页面不可滚时回退到影子树内最大的滚动容器', () => {
  const host = document.createElement('div')
  const root = host.attachShadow({ mode: 'open' })
  const content = document.createElement('div')
  content.style.overflowY = 'auto'
  root.append(content)
  document.body.append(host)
  const scrollable = makeScrollable(content, { clientHeight: 600, scrollHeight: 2000 })
  window.scrollBy = vi.fn() as unknown as typeof window.scrollBy
  const controller = new PageController()
  controller.capture()

  controller.scroll(1)

  expect(scrollable.scrollTop).toBeGreaterThan(0)
})
```

- [x] **Step 3: 运行控制器测试并确认 RED**

Run:

```bash
npx vitest run packages/executor/src/controller.spec.ts
```

Expected: 基础点击、输入和选择可能已因快照集成通过；校验错误和最大滚动容器用例应失败，证明整页辅助扫描仍只看 Document Tree。

- [x] **Step 4: 控制器整页扫描复用 composedElements**

在 `packages/executor/src/controller.ts` 导入：

```ts
import {
  closestComposed,
  composedContains,
  composedElements,
  composedTextContent
} from './composedTree'
```

`validationErrors()` 改为：

```ts
return Array.from(composedElements(document))
  .filter(element => element.matches('[role="alert"]'))
  .filter(alert => closestComposed(alert, 'form') && isElementVisible(alert))
  .map(alert => collapseText(composedTextContent(alert)))
  .filter(text => text !== '')
  .filter((text, index, all) => all.indexOf(text) === index)
```

`largestScrollable()` 的扫描改为：

```ts
for (const node of composedElements(view.document)) {
  if (!(node instanceof view.HTMLElement)) continue
  // 保留现有滚动距离、overflow 和面积比较
}
```

- [x] **Step 5: 补齐复合下拉的跨边界关系**

在 `selectFromPopup()` 中把：

```ts
!trigger.contains(item.dom)
```

改为：

```ts
!composedContains(trigger, item.dom)
```

`isExpanded()` 的祖先路径使用 `closestComposed(trigger, '[aria-expanded="true"]')`，后代路径
使用 `composedElements(trigger)` 查找 `aria-expanded="true"`。

- [x] **Step 6: 运行控制器和 executor 测试并确认 GREEN**

Run:

```bash
npx vitest run packages/executor/src/controller.spec.ts packages/executor/src/tools.spec.ts packages/executor/src/elementui.spec.ts packages/executor/src/antd.spec.ts
```

Expected: 所有目标测试通过；既有复合下拉、表单校验和滚动行为不回归。

- [x] **Step 7: 提交控制器集成**

```bash
test "$(git branch --show-current)" = "feat_20260801_ShadowDOM元素捕获"
git add packages/executor/src/controller.ts packages/executor/src/controller.spec.ts
git commit -m "feat: 页面控制器支持 Shadow DOM 元素"
```

### Task 4: 分层验证、文档复审和独立 PR

**Files:**
- Modify: `docs/feat_20260801_ShadowDOM元素捕获/plan.md`
- Create: `docs/feat_20260801_ShadowDOM元素捕获/test-results.md`
- Create: `docs/feat_20260801_ShadowDOM元素捕获/review.md`

- [x] **Step 1: 运行 executor 全包测试**

```bash
npx vitest run packages/executor/src
```

Expected: executor 全部测试通过。

- [x] **Step 2: 运行全仓验证**

```bash
npm run verify
git diff --check
```

Expected: 全仓测试、所有 workspace 类型检查和构建通过，diff 无空白错误。

- [x] **Step 3: 复审完整 diff**

核对：

- `composedTree.ts` 未从 `packages/executor/src/index.ts` 导出。
- closed Shadow Root 与 iframe 边界未被扩大。
- slot 文本、fallback、未分发 light DOM 和去重契约与设计一致。
- `snapshot.elements[i]` 与真实元素引用仍在同一遍历中同步追加。
- 密码、token、验证码等值仍走既有脱敏逻辑。
- 普通 DOM 顺序、层级、遮挡、下拉和滚动测试无回归。

- [x] **Step 4: 记录红绿、测试和评审结果**

`test-results.md` 记录每一轮 RED/GREEN 的命令、退出码和失败原因；`review.md` 用表格记录
设计覆盖、公开契约、安全边界、性能和改动范围。

- [ ] **Step 5: 提交交付文档**

```bash
test "$(git branch --show-current)" = "feat_20260801_ShadowDOM元素捕获"
git add docs/feat_20260801_ShadowDOM元素捕获
git commit -m "feat: 记录 Shadow DOM 捕获验证结果"
```

- [ ] **Step 6: 首次推送并创建独立 PR**

首次推送严格使用：

```bash
test "$(git branch --show-current)" = "feat_20260801_ShadowDOM元素捕获"
git push -u origin feat_20260801_ShadowDOM元素捕获:feat_20260801_ShadowDOM元素捕获
```

创建目标为 `main` 的 PR，标题使用：

```text
feat: 支持 Shadow DOM 元素捕获
```

PR 只包含 composed tree、executor 集成、测试与本分支文档，不删除本地或远端分支。

## 执行结果

- 实现提交：`b412310`、`61c0951`、`2944447`。
- executor 最终验证：12 个测试文件、196/196 测试通过。
- 全仓最终验证：48 个测试文件、727/727 测试通过；类型检查和构建通过。
- 详细红绿记录见 [test-results.md](test-results.md)。
- 完整复审结论见 [review.md](review.md)。
