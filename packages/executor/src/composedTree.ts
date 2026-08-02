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

function traversalRoot(root: ParentNode): ParentNode {
  if (root.nodeType !== DOCUMENT_NODE) return root
  return (root as Document).body ?? root
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

  yield* visit(traversalRoot(root))
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

export function composedParent(element: Element): Element | null {
  try {
    if (element.assignedSlot) return element.assignedSlot
  } catch (_error) {
    return null
  }
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
