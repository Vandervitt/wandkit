# 多实例卸载竞态 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Fetch、XHR、Beacon 的多个 interceptor 实例可安全叠加和按任意顺序卸载，且不覆盖后安装的外部 wrapper。

**Architecture:** 每个本库 wrapper 携带跨 bundle 可识别的 patch 元数据和生命周期对象。卸载先使本层失活；失活 wrapper 只透明调用前一层，当前函数仍是本层时才沿元数据链跳过失活层并恢复。

**Tech Stack:** TypeScript、DOM Fetch/XHR/Beacon API、Promise、WeakMap、`Symbol.for`、Vitest、jsdom、tsup

---

### Task 1: Fetch 多实例与外部 wrapper 回归测试

**Files:**
- Modify: `packages/interceptor/src/interceptor.spec.ts`

- [x] **Step 1: 写入非 LIFO 卸载失败测试**

在生命周期相关的 `describe` 中加入以下用例。它先证明两层都生效，再先卸载旧实例 A，
验证 B 仍能拒绝请求且 A 不再判定，最后验证浏览器函数引用完全恢复：

```ts
it('先卸载旧 Fetch 实例只移除该层，最后卸载恢复基线函数', async () => {
  const baselineFetch = window.fetch
  const confirmA = vi.fn<Parameters<ConfirmRequestHandler>, Promise<boolean>>(
    async () => true
  )
  const confirmB = vi.fn<Parameters<ConfirmRequestHandler>, Promise<boolean>>(
    async () => true
  )
  const instanceA = createInterceptor({
    policy: {}, attribution: createStaticAttribution(true), confirm: confirmA,
    channels: ['fetch']
  })
  const instanceB = createInterceptor({
    policy: {}, attribution: createStaticAttribution(true), confirm: confirmB,
    channels: ['fetch']
  })
  const uninstallA = instanceA.install()
  const uninstallB = instanceB.install()

  try {
    await fetch('/api/users/u_1', { method: 'DELETE' })
    expect(confirmB).toHaveBeenCalledTimes(1)
    expect(confirmA).toHaveBeenCalledTimes(1)

    confirmA.mockClear()
    confirmB.mockClear()
    sent = []
    confirmB.mockResolvedValueOnce(false)
    uninstallA()

    await expect(fetch('/api/users/u_2', { method: 'DELETE' }))
      .rejects.toBeInstanceOf(RequestDeniedError)
    expect(confirmB).toHaveBeenCalledTimes(1)
    expect(confirmA).not.toHaveBeenCalled()
    expect(sent).toHaveLength(0)

    uninstallB()
    expect(window.fetch).toBe(baselineFetch)
  } finally {
    uninstallB()
    uninstallA()
    window.fetch = baselineFetch
  }
})
```

- [x] **Step 2: 写入 LIFO 卸载测试**

```ts
it('按 LIFO 卸载 Fetch 实例时保留前一激活层', async () => {
  const baselineFetch = window.fetch
  const confirmA = vi.fn(async () => true)
  const confirmB = vi.fn(async () => true)
  const instanceA = createInterceptor({
    policy: {}, attribution: createStaticAttribution(true), confirm: confirmA,
    channels: ['fetch']
  })
  const instanceB = createInterceptor({
    policy: {}, attribution: createStaticAttribution(true), confirm: confirmB,
    channels: ['fetch']
  })
  const uninstallA = instanceA.install()
  const wrapperA = window.fetch
  const uninstallB = instanceB.install()

  try {
    uninstallB()
    expect(window.fetch).toBe(wrapperA)
    await fetch('/api/users/u_1', { method: 'DELETE' })
    expect(confirmA).toHaveBeenCalledTimes(1)
    expect(confirmB).not.toHaveBeenCalled()

    uninstallA()
    expect(window.fetch).toBe(baselineFetch)
  } finally {
    uninstallB()
    uninstallA()
    window.fetch = baselineFetch
  }
})
```

- [x] **Step 3: 写入外部 wrapper 边界测试**

```ts
it('卸载 Fetch 实例不覆盖后安装的外部 wrapper，旧引用只透明透传', async () => {
  const baselineFetch = window.fetch
  const confirmA = vi.fn(async () => true)
  const instanceA = createInterceptor({
    policy: {}, attribution: createStaticAttribution(true), confirm: confirmA,
    channels: ['fetch']
  })
  const uninstallA = instanceA.install()
  const interceptedFetch = window.fetch
  const externalFetch = vi.fn(function (
    this: unknown,
    ...args: Parameters<typeof fetch>
  ) {
    return interceptedFetch.apply(this, args)
  }) as typeof fetch
  window.fetch = externalFetch

  try {
    uninstallA()
    expect(window.fetch).toBe(externalFetch)
    await fetch('/api/users/u_1', { method: 'DELETE' })
    expect(externalFetch).toHaveBeenCalledTimes(1)
    expect(confirmA).not.toHaveBeenCalled()
    expect(sent).toHaveLength(1)
  } finally {
    window.fetch = baselineFetch
    uninstallA()
  }
})
```

- [x] **Step 4: 运行测试确认旧实现失败**

Run:

```bash
npx vitest run packages/interceptor/src/interceptor.spec.ts
```

Expected: FAIL。非 LIFO 用例中 B 被 A 的卸载拆除；外部 wrapper 用例中外部函数被覆盖，
且直接持有的旧 wrapper 仍会执行 A 的确认。

- [x] **Step 5: 提交红灯测试**

```bash
test "$(git branch --show-current)" = "fix_20260731_多实例卸载竞态"
git add packages/interceptor/src/interceptor.spec.ts
test "$(git branch --show-current)" = "fix_20260731_多实例卸载竞态"
git commit -m "fix: 复现 Fetch 多实例卸载竞态"
```

### Task 2: XHR 与 Beacon 多实例回归测试

**Files:**
- Modify: `packages/interceptor/src/channels.spec.ts`

- [x] **Step 1: 写入 XHR 非 LIFO 卸载测试**

```ts
it('先卸载旧 XHR 实例时新实例仍生效，最后恢复 open 和 send', async () => {
  const baselineOpen = XMLHttpRequest.prototype.open
  const baselineSend = XMLHttpRequest.prototype.send
  const confirmA = vi.fn(async () => true)
  const confirmB = vi.fn(async () => true)
  const instanceA = createInterceptor({
    policy: {}, attribution: createStaticAttribution(true), confirm: confirmA,
    channels: ['xhr']
  })
  const instanceB = createInterceptor({
    policy: {}, attribution: createStaticAttribution(true), confirm: confirmB,
    channels: ['xhr']
  })
  const uninstallA = instanceA.install()
  const uninstallB = instanceB.install()

  try {
    await xhr('DELETE', '/api/users/u_1')
    expect(confirmB).toHaveBeenCalledTimes(1)
    expect(confirmA).toHaveBeenCalledTimes(1)
    expect(sent).toHaveLength(1)

    confirmA.mockClear()
    confirmB.mockClear()
    sent = []
    uninstallA()
    await xhr('DELETE', '/api/users/u_2')

    expect(confirmB).toHaveBeenCalledTimes(1)
    expect(confirmA).not.toHaveBeenCalled()
    expect(sent).toEqual([
      { channel: 'xhr', method: 'DELETE', url: '/api/users/u_2' }
    ])

    uninstallB()
    expect(XMLHttpRequest.prototype.open).toBe(baselineOpen)
    expect(XMLHttpRequest.prototype.send).toBe(baselineSend)
  } finally {
    uninstallB()
    uninstallA()
    XMLHttpRequest.prototype.open = baselineOpen
    XMLHttpRequest.prototype.send = baselineSend
  }
})
```

- [x] **Step 2: 写入 XHR 与 Beacon 的 LIFO 卸载测试**

```ts
it('按 LIFO 卸载 XHR 实例时保留前一激活层', async () => {
  const baselineOpen = XMLHttpRequest.prototype.open
  const baselineSend = XMLHttpRequest.prototype.send
  const confirmA = vi.fn(async () => true)
  const confirmB = vi.fn(async () => true)
  const instanceA = createInterceptor({
    policy: {}, attribution: createStaticAttribution(true), confirm: confirmA,
    channels: ['xhr']
  })
  const instanceB = createInterceptor({
    policy: {}, attribution: createStaticAttribution(true), confirm: confirmB,
    channels: ['xhr']
  })
  const uninstallA = instanceA.install()
  const wrapperAOpen = XMLHttpRequest.prototype.open
  const wrapperASend = XMLHttpRequest.prototype.send
  const uninstallB = instanceB.install()

  try {
    uninstallB()
    expect(XMLHttpRequest.prototype.open).toBe(wrapperAOpen)
    expect(XMLHttpRequest.prototype.send).toBe(wrapperASend)
    await xhr('DELETE', '/api/users/u_1')
    expect(confirmA).toHaveBeenCalledTimes(1)
    expect(confirmB).not.toHaveBeenCalled()

    uninstallA()
    expect(XMLHttpRequest.prototype.open).toBe(baselineOpen)
    expect(XMLHttpRequest.prototype.send).toBe(baselineSend)
  } finally {
    uninstallB()
    uninstallA()
    XMLHttpRequest.prototype.open = baselineOpen
    XMLHttpRequest.prototype.send = baselineSend
  }
})

it('按 LIFO 卸载 Beacon 实例时保留前一激活层', () => {
  const baselineBeacon = navigator.sendBeacon
  const verdictA = vi.fn()
  const verdictB = vi.fn()
  const policy: InterceptionPolicy = {
    allow: [{ id: 'metrics', match: { url: '/api/metrics' } }]
  }
  const instanceA = createInterceptor({
    policy, attribution: createStaticAttribution(true), confirm: vi.fn(async () => true),
    channels: ['beacon'], onVerdict: verdictA
  })
  const instanceB = createInterceptor({
    policy, attribution: createStaticAttribution(true), confirm: vi.fn(async () => true),
    channels: ['beacon'], onVerdict: verdictB
  })
  const uninstallA = instanceA.install()
  const wrapperA = navigator.sendBeacon
  const uninstallB = instanceB.install()

  try {
    uninstallB()
    expect(navigator.sendBeacon).toBe(wrapperA)
    expect(navigator.sendBeacon('/api/metrics', '{}')).toBe(true)
    expect(verdictA).toHaveBeenCalledTimes(1)
    expect(verdictB).not.toHaveBeenCalled()

    uninstallA()
    expect(navigator.sendBeacon).toBe(baselineBeacon)
  } finally {
    uninstallB()
    uninstallA()
    navigator.sendBeacon = baselineBeacon
  }
})
```

- [x] **Step 3: 写入 XHR 外部只替换 open 与只替换 send 的测试**

```ts
it('XHR 卸载分别保留外部 open，并让其持有的旧 open 透明透传', async () => {
  const baselineOpen = XMLHttpRequest.prototype.open
  const baselineSend = XMLHttpRequest.prototype.send
  const confirmA = vi.fn(async () => true)
  const instanceA = createInterceptor({
    policy: {}, attribution: createStaticAttribution(true), confirm: confirmA,
    channels: ['xhr']
  })
  const uninstallA = instanceA.install()
  const interceptedOpen = XMLHttpRequest.prototype.open
  const externalOpen = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    return (interceptedOpen as (...args: unknown[]) => void)
      .apply(this, [method, url, ...rest])
  } as typeof XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = externalOpen

  try {
    uninstallA()
    expect(XMLHttpRequest.prototype.open).toBe(externalOpen)
    expect(XMLHttpRequest.prototype.send).toBe(baselineSend)
    await xhr('DELETE', '/api/users/u_1')
    expect(confirmA).not.toHaveBeenCalled()
    expect(sent).toHaveLength(1)
  } finally {
    XMLHttpRequest.prototype.open = baselineOpen
    XMLHttpRequest.prototype.send = baselineSend
    uninstallA()
  }
})

it('XHR 卸载分别保留外部 send，并让其持有的旧 send 透明透传', async () => {
  const baselineOpen = XMLHttpRequest.prototype.open
  const baselineSend = XMLHttpRequest.prototype.send
  const confirmA = vi.fn(async () => true)
  const instanceA = createInterceptor({
    policy: {}, attribution: createStaticAttribution(true), confirm: confirmA,
    channels: ['xhr']
  })
  const uninstallA = instanceA.install()
  const interceptedSend = XMLHttpRequest.prototype.send
  const externalSend = function (
    this: XMLHttpRequest,
    ...args: Parameters<typeof XMLHttpRequest.prototype.send>
  ) {
    return interceptedSend.apply(this, args)
  } as typeof XMLHttpRequest.prototype.send
  XMLHttpRequest.prototype.send = externalSend

  try {
    uninstallA()
    expect(XMLHttpRequest.prototype.open).toBe(baselineOpen)
    expect(XMLHttpRequest.prototype.send).toBe(externalSend)
    await xhr('DELETE', '/api/users/u_1')
    expect(confirmA).not.toHaveBeenCalled()
    expect(sent).toHaveLength(1)
  } finally {
    XMLHttpRequest.prototype.open = baselineOpen
    XMLHttpRequest.prototype.send = baselineSend
    uninstallA()
  }
})
```

- [x] **Step 4: 写入 Beacon 非 LIFO 与外部 wrapper 测试**

```ts
it('先卸载旧 Beacon 实例只移除该层，最后恢复基线函数', () => {
  const baselineBeacon = navigator.sendBeacon
  const verdictA = vi.fn()
  const verdictB = vi.fn()
  const policy: InterceptionPolicy = {
    allow: [{ id: 'metrics', match: { url: '/api/metrics' } }]
  }
  const instanceA = createInterceptor({
    policy, attribution: createStaticAttribution(true), confirm: vi.fn(async () => true),
    channels: ['beacon'], onVerdict: verdictA
  })
  const instanceB = createInterceptor({
    policy, attribution: createStaticAttribution(true), confirm: vi.fn(async () => true),
    channels: ['beacon'], onVerdict: verdictB
  })
  const uninstallA = instanceA.install()
  const uninstallB = instanceB.install()

  try {
    expect(navigator.sendBeacon('/api/metrics', '{}')).toBe(true)
    expect(verdictB).toHaveBeenCalledTimes(1)
    expect(verdictA).toHaveBeenCalledTimes(1)

    verdictA.mockClear()
    verdictB.mockClear()
    sent = []
    uninstallA()
    expect(navigator.sendBeacon('/api/metrics', '{}')).toBe(true)
    expect(verdictB).toHaveBeenCalledTimes(1)
    expect(verdictA).not.toHaveBeenCalled()
    expect(sent).toHaveLength(1)

    uninstallB()
    expect(navigator.sendBeacon).toBe(baselineBeacon)
  } finally {
    uninstallB()
    uninstallA()
    navigator.sendBeacon = baselineBeacon
  }
})

it('Beacon 卸载不覆盖外部 wrapper，旧引用只透明透传', () => {
  const baselineBeacon = navigator.sendBeacon
  const verdictA = vi.fn()
  const policy: InterceptionPolicy = {
    allow: [{ id: 'metrics', match: { url: '/api/metrics' } }]
  }
  const instanceA = createInterceptor({
    policy, attribution: createStaticAttribution(true), confirm: vi.fn(async () => true),
    channels: ['beacon'], onVerdict: verdictA
  })
  const uninstallA = instanceA.install()
  const interceptedBeacon = navigator.sendBeacon
  const externalBeacon = vi.fn(function (
    this: Navigator,
    ...args: Parameters<typeof navigator.sendBeacon>
  ) {
    return interceptedBeacon.apply(this, args)
  }) as typeof navigator.sendBeacon
  navigator.sendBeacon = externalBeacon

  try {
    uninstallA()
    expect(navigator.sendBeacon).toBe(externalBeacon)
    expect(navigator.sendBeacon('/api/metrics', '{}')).toBe(true)
    expect(externalBeacon).toHaveBeenCalledTimes(1)
    expect(verdictA).not.toHaveBeenCalled()
    expect(sent).toHaveLength(1)
  } finally {
    navigator.sendBeacon = baselineBeacon
    uninstallA()
  }
})
```

- [x] **Step 5: 运行测试确认旧实现失败**

Run:

```bash
npx vitest run packages/interceptor/src/channels.spec.ts
```

Expected: FAIL。旧实例卸载会拆掉新 XHR/Beacon 层并覆盖外部方法；直接持有的旧 wrapper
也不会透明失活。

- [x] **Step 6: 提交红灯测试**

```bash
test "$(git branch --show-current)" = "fix_20260731_多实例卸载竞态"
git add packages/interceptor/src/channels.spec.ts
test "$(git branch --show-current)" = "fix_20260731_多实例卸载竞态"
git commit -m "fix: 复现请求通道多实例卸载竞态"
```

### Task 3: Patch 元数据与 Fetch 安全卸载

**Files:**
- Modify: `packages/interceptor/src/interceptor.ts`
- Test: `packages/interceptor/src/interceptor.spec.ts`

- [x] **Step 1: 增加内部 patch 元数据与解链辅助函数**

在 `DEFAULT_CHANNELS` 后加入以下私有实现；不从包入口导出：

```ts
const PATCH_SOURCE = '@wandkit/interceptor' as const
const PATCH_METADATA = Symbol.for(`${PATCH_SOURCE}.patch`)

type PatchKind = 'fetch' | 'xhr-open' | 'xhr-send' | 'beacon'

interface PatchLifecycle {
  active: boolean
}

interface PatchMetadata {
  source: typeof PATCH_SOURCE
  kind: PatchKind
  lifecycle: PatchLifecycle
  previous: CallableFunction
}

function markPatch<F extends CallableFunction>(
  wrapper: F,
  kind: PatchKind,
  lifecycle: PatchLifecycle,
  previous: F
): F {
  Object.defineProperty(wrapper, PATCH_METADATA, {
    value: { source: PATCH_SOURCE, kind, lifecycle, previous } satisfies PatchMetadata
  })
  return wrapper
}

function readPatchMetadata(value: unknown): PatchMetadata | undefined {
  if (typeof value !== 'function') return undefined
  const metadata = (value as CallableFunction & Record<symbol, unknown>)[PATCH_METADATA]
  if (!metadata || typeof metadata !== 'object') return undefined
  const candidate = metadata as Partial<PatchMetadata>
  if (
    candidate.source !== PATCH_SOURCE ||
    !isPatchKind(candidate.kind) ||
    typeof candidate.previous !== 'function' ||
    !candidate.lifecycle ||
    typeof candidate.lifecycle.active !== 'boolean'
  ) return undefined
  return candidate as PatchMetadata
}

function isPatchKind(value: unknown): value is PatchKind {
  return value === 'fetch' || value === 'xhr-open' ||
    value === 'xhr-send' || value === 'beacon'
}

function skipInactivePatches<F extends CallableFunction>(
  previous: F,
  kind: PatchKind
): F {
  let current: CallableFunction = previous
  const visited = new Set<CallableFunction>()
  while (!visited.has(current)) {
    visited.add(current)
    const metadata = readPatchMetadata(current)
    if (!metadata || metadata.kind !== kind || metadata.lifecycle.active) break
    current = metadata.previous
  }
  return current as F
}
```

- [x] **Step 2: 改造 Fetch wrapper**

用独立生命周期标记 wrapper；失活时直接调用捕获的 `original`，卸载时只在当前属性仍是
本层 wrapper 时恢复：

```ts
const original = view.fetch
if (typeof original !== 'function') return () => undefined
const lifecycle: PatchLifecycle = { active: true }

const patchedFetch = async function patchedFetch(
  this: unknown,
  ...args: Parameters<typeof fetch>
) {
  if (!lifecycle.active) return original.apply(this, args)
  const request = await toInterceptedRequest(args, nextId())
  if (!(await gate(request))) throw new RequestDeniedError(request)
  return original.apply(this, args)
} as typeof fetch

markPatch(patchedFetch, 'fetch', lifecycle, original)
view.fetch = patchedFetch

return () => {
  lifecycle.active = false
  if (view.fetch === patchedFetch) {
    view.fetch = skipInactivePatches(original, 'fetch')
  }
}
```

- [x] **Step 3: 运行 Fetch 测试确认转绿**

Run:

```bash
npx vitest run packages/interceptor/src/interceptor.spec.ts
npm run typecheck --workspace @wandkit/interceptor
```

Expected: `interceptor.spec.ts` 全部 PASS，interceptor 类型检查退出码 0。

- [x] **Step 4: 提交 Fetch 实现**

```bash
test "$(git branch --show-current)" = "fix_20260731_多实例卸载竞态"
git add packages/interceptor/src/interceptor.ts
test "$(git branch --show-current)" = "fix_20260731_多实例卸载竞态"
git commit -m "fix: 支持 Fetch 多实例安全卸载"
```

### Task 4: XHR 与 Beacon 透明失活和安全恢复

**Files:**
- Modify: `packages/interceptor/src/interceptor.ts`
- Test: `packages/interceptor/src/channels.spec.ts`

- [x] **Step 1: 将 XHR 状态改为 patch 层私有并共享生命周期**

删除模块级 `xhrState`，在 `patchXhr()` 中创建每层独立的 `callState` 和生命周期。`open`
失活时原样透传，激活时只写入本层状态：

```ts
const originalOpen = XHR.prototype.open
const originalSend = XHR.prototype.send
const lifecycle: PatchLifecycle = { active: true }
const callState = new WeakMap<XMLHttpRequest, XhrCallState>()

const patchedOpen = function patchedOpen(
  this: XMLHttpRequest,
  method: string,
  url: string | URL,
  ...rest: unknown[]
) {
  if (!lifecycle.active) {
    return (originalOpen as (...args: unknown[]) => void)
      .apply(this, [method, url, ...rest])
  }
  callState.set(this, { method: method.toUpperCase(), url: String(url) })
  return (originalOpen as (...args: unknown[]) => void)
    .apply(this, [method, url, ...rest])
} as typeof XMLHttpRequest.prototype.open
```

- [x] **Step 2: 让 XHR send 失活时同步透传，激活时保持 continuation 校验**

```ts
const patchedSend = function patchedSend(
  this: XMLHttpRequest,
  ...args: Parameters<typeof XMLHttpRequest.prototype.send>
) {
  if (!lifecycle.active) return originalSend.apply(this, args)
  const [body] = args
  const state = callState.get(this)
  const request: InterceptedRequest = {
    id: nextId(),
    method: state?.method ?? 'GET',
    url: state?.url ?? '',
    headers: {},
    body: parseBody(body as BodyInit | null | undefined),
    channel: 'xhr',
    timestamp: Date.now()
  }
  void gate(request).then(allowed => {
    if (allowed && lifecycle.active && callState.get(this) === state) {
      originalSend.apply(this, args)
    }
  })
} as typeof XMLHttpRequest.prototype.send

markPatch(patchedOpen, 'xhr-open', lifecycle, originalOpen)
markPatch(patchedSend, 'xhr-send', lifecycle, originalSend)
XHR.prototype.open = patchedOpen
XHR.prototype.send = patchedSend

return () => {
  lifecycle.active = false
  if (XHR.prototype.open === patchedOpen) {
    XHR.prototype.open = skipInactivePatches(originalOpen, 'xhr-open')
  }
  if (XHR.prototype.send === patchedSend) {
    XHR.prototype.send = skipInactivePatches(originalSend, 'xhr-send')
  }
}
```

- [x] **Step 3: 改造 Beacon wrapper**

```ts
const original = navigatorRef?.sendBeacon
if (typeof original !== 'function') return () => undefined
const lifecycle: PatchLifecycle = { active: true }

const patchedBeacon = function patchedBeacon(
  this: Navigator,
  ...args: Parameters<typeof original>
): ReturnType<typeof original> {
  if (!lifecycle.active) return original.apply(this, args)
  const [url, data] = args
  const request: InterceptedRequest = {
    id: nextId(),
    method: 'POST',
    url: String(url),
    headers: {},
    body: parseBody(data),
    channel: 'beacon',
    timestamp: Date.now()
  }
  const evaluated = evaluate(request, options)
  options.onVerdict?.(request, evaluated.verdict)
  if (evaluated.verdict.action === 'allow') return original.apply(this, args)
  options.onUnholdableRequest?.(request)
  return false
} as typeof original

markPatch(patchedBeacon, 'beacon', lifecycle, original)
navigatorRef.sendBeacon = patchedBeacon

return () => {
  lifecycle.active = false
  if (navigatorRef.sendBeacon === patchedBeacon) {
    navigatorRef.sendBeacon = skipInactivePatches(original, 'beacon')
  }
}
```

- [x] **Step 4: 运行通道测试与包级检查确认转绿**

Run:

```bash
npx vitest run packages/interceptor/src/channels.spec.ts \
  packages/interceptor/src/interceptor.spec.ts
npm run typecheck --workspace @wandkit/interceptor
git diff --check
```

Expected: 两个测试文件全部 PASS，类型检查和 diff 检查退出码 0。

- [x] **Step 5: 提交通道实现**

```bash
test "$(git branch --show-current)" = "fix_20260731_多实例卸载竞态"
git add packages/interceptor/src/interceptor.ts packages/interceptor/src/channels.spec.ts
test "$(git branch --show-current)" = "fix_20260731_多实例卸载竞态"
git commit -m "fix: 修复请求通道多实例卸载竞态"
```

### Task 5: 完整验证、复审和交付记录

**Files:**
- Create: `docs/fix_20260731_多实例卸载竞态/test-results.md`
- Create: `docs/fix_20260731_多实例卸载竞态/review.md`
- Modify: `docs/fix_20260731_多实例卸载竞态/plan.md`

- [x] **Step 1: 运行完整验证门槛**

Run:

```bash
npm run verify
git diff --check
```

Expected: 全部 Vitest 测试、workspace 类型检查和构建通过；`git diff --check` 无输出。

- [x] **Step 2: 执行独立复审**

使用 `superpowers:requesting-code-review` 审查基线 `3b7e145` 到当前 HEAD 的完整 diff，重点
核对：

- 非 LIFO 与 LIFO 卸载均不会拆除激活层。
- 失活层无 ID、判定、trace、确认等副作用。
- XHR `open/send` 的生命周期一致且 continuation 仍受卸载与状态身份保护。
- 外部 wrapper 边界不会被恢复逻辑覆盖。
- 元数据校验和循环保护不会误跳过普通外部函数。
- 没有公开 API 或构建产物变化。

Expected: Critical/Important 问题为 0；若发现问题，修复并重新运行受影响测试和
`npm run verify`。

- [x] **Step 3: 写入真实结果**

`test-results.md` 必须记录：基线测试、各红灯用例的失败原因、绿灯命令、完整测试数量、
类型检查和构建退出码。`review.md` 必须记录 scope、数据流、外部边界、复审结论和仍存在
的非目标限制。将本计划已完成步骤的复选框更新为 `[x]`。

- [x] **Step 4: 提交验证与复审记录**

```bash
test "$(git branch --show-current)" = "fix_20260731_多实例卸载竞态"
git add -- 'docs/fix_20260731_多实例卸载竞态/plan.md' \
  'docs/fix_20260731_多实例卸载竞态/test-results.md' \
  'docs/fix_20260731_多实例卸载竞态/review.md'
test "$(git branch --show-current)" = "fix_20260731_多实例卸载竞态"
git commit -m "fix: 记录多实例卸载验证结论"
```

### Task 6: 推送并创建独立 PR

**Files:**
- No file changes

- [x] **Step 1: 推送前核对分支与工作区**

Run:

```bash
git branch --show-current
git status --short --branch
git branch -vv
```

Expected: 当前分支为 `fix_20260731_多实例卸载竞态`，工作区干净，分支未错误跟踪
`origin/main`。

- [x] **Step 2: 首次同名推送**

```bash
git push -u origin fix_20260731_多实例卸载竞态:fix_20260731_多实例卸载竞态
```

Expected: 推送成功，设置同名远端跟踪分支。

- [x] **Step 3: 创建 PR**

以 `main` 为基线创建独立 PR。标题使用中文 Conventional Commit 风格，正文包含问题、
根因、方案、红绿测试证据、完整验证和风险边界；不自动合入。
