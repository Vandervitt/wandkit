# Native Form Interception Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让显式配置 `channels: ['form']` 时，原生 submit、`requestSubmit()` 与直接 `form.submit()` 都进入现有请求闸门，同时保持 SPA、多实例、卸载和快照一致性语义。

**Architecture:** 把现有 wrapper 生命周期元数据抽到内部 `patchLifecycle.ts`，新增独立 `form.ts` 负责表单快照、`InterceptedRequest` 投影、Window submit 事件协调、prototype submit patch 与安全重放。`createInterceptor().install()` 按通道事务式安装；任何一步失败均逆序回滚并恢复 `installed === false`。

**Tech Stack:** TypeScript 5.4、DOM APIs、Vitest 1.6、jsdom 29、tsup。

---

## 文件边界

| 文件 | 职责 |
|---|---|
| `packages/interceptor/src/patchLifecycle.ts` | 私有 patch 元数据、跨 bundle 识别、连续失活 wrapper 跳过 |
| `packages/interceptor/src/form.ts` | 表单快照、请求投影、事件多实例协调、直接 submit patch、安全重放 |
| `packages/interceptor/src/interceptor.ts` | 复用生命周期模块、安装 form、事务式回滚 |
| `packages/interceptor/src/form.spec.ts` | form 行为、投影、竞态、多实例、外部 wrapper 与安装失败回归测试 |
| `packages/interceptor/README.md` | form 开启方式、时序代价、`formdata` 幂等要求与监听器边界 |
| `docs/fix_20260801_原生表单拦截/test-results.md` | 红绿记录、分层验证、完整验证和浏览器冒烟结果 |
| `docs/fix_20260801_原生表单拦截/review.md` | 规格覆盖、公开契约、diff 与风险复审结论 |

### Task 1: 抽取通用 patch 生命周期模块

**Files:**
- Create: `packages/interceptor/src/patchLifecycle.ts`
- Modify: `packages/interceptor/src/interceptor.ts`
- Test: `packages/interceptor/src/interceptor.spec.ts`
- Test: `packages/interceptor/src/channels.spec.ts`

- [ ] **Step 1: 运行现有生命周期回归测试作为重构基线**

Run:

```bash
npx vitest run packages/interceptor/src/interceptor.spec.ts packages/interceptor/src/channels.spec.ts
```

Expected: PASS；记录当前 Fetch/XHR/Beacon 多实例、旧引用和外部 wrapper 用例均为绿色。

- [ ] **Step 2: 新增内部生命周期模块**

Create `packages/interceptor/src/patchLifecycle.ts` with:

```ts
const PATCH_SOURCE = '@wandkit/interceptor' as const
const PATCH_METADATA = Symbol.for(`${PATCH_SOURCE}.patch`)

export type PatchKind =
  | 'fetch'
  | 'xhr-open'
  | 'xhr-send'
  | 'beacon'
  | 'form-submit'

export interface PatchLifecycle {
  active: boolean
}

interface PatchMetadata {
  source: typeof PATCH_SOURCE
  kind: PatchKind
  lifecycle: PatchLifecycle
  previous: CallableFunction
}

export function markPatch<F extends CallableFunction>(
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
  try {
    const metadata = (value as CallableFunction & Record<PropertyKey, unknown>)[PATCH_METADATA]
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
  } catch (_error) {
    return undefined
  }
}

function isPatchKind(value: unknown): value is PatchKind {
  return value === 'fetch' || value === 'xhr-open' ||
    value === 'xhr-send' || value === 'beacon' || value === 'form-submit'
}

export function skipInactivePatches<F extends CallableFunction>(
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

- [ ] **Step 3: 让现有三类 patch 使用新模块**

At the top of `packages/interceptor/src/interceptor.ts`, add:

```ts
import {
  markPatch,
  skipInactivePatches,
  type PatchLifecycle
} from './patchLifecycle'
```

Delete the local `PATCH_SOURCE`、`PATCH_METADATA`、`PatchKind`、`PatchLifecycle`、`PatchMetadata`、`markPatch()`、`readPatchMetadata()`、`isPatchKind()` and `skipInactivePatches()` definitions. Do not export `patchLifecycle.ts` from `packages/interceptor/src/index.ts`.

- [ ] **Step 4: 运行抽取后的回归测试**

Run:

```bash
npx vitest run packages/interceptor/src/interceptor.spec.ts packages/interceptor/src/channels.spec.ts
npm run typecheck --workspace @wandkit/interceptor
```

Expected: PASS；测试数量与抽取前一致，类型检查退出码为 0。

- [ ] **Step 5: 提交纯重构**

```bash
git branch --show-current
git add packages/interceptor/src/patchLifecycle.ts packages/interceptor/src/interceptor.ts
git commit -m "fix: 抽取拦截器补丁生命周期"
```

Expected: 当前分支为 `fix_20260801_原生表单拦截`，提交成功且无 AI 署名。

### Task 2: 建立 form 测试设施并接通两类提交入口

**Files:**
- Create: `packages/interceptor/src/form.spec.ts`
- Create: `packages/interceptor/src/form.ts`
- Modify: `packages/interceptor/src/interceptor.ts`

- [ ] **Step 1: 写原生 submit 与直接 submit 的首批失败测试**

Create `packages/interceptor/src/form.spec.ts` with imports and shared helpers:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStaticAttribution } from './attribution'
import { createInterceptor } from './interceptor'
import type {
  ConfirmRequestHandler,
  Interceptor,
  InterceptorOptions
} from './interceptor'

const originalSubmit = HTMLFormElement.prototype.submit
let interceptor: Interceptor | undefined
let uninstall: (() => void) | undefined
let submitted: HTMLFormElement[]

function setup(overrides: Partial<InterceptorOptions> = {}) {
  const confirm = vi.fn<Parameters<ConfirmRequestHandler>, Promise<boolean>>(
    async () => true
  )
  interceptor = createInterceptor({
    policy: { defaultForSafeMethods: 'confirm' },
    attribution: createStaticAttribution(true),
    confirm,
    channels: ['form'],
    ...overrides
  })
  uninstall = interceptor.install()
  return { confirm }
}

function createForm(markup = '<input name="name" value="张三">'): HTMLFormElement {
  const form = document.createElement('form')
  form.action = '/api/users'
  form.method = 'post'
  form.innerHTML = markup
  document.body.append(form)
  return form
}

function dispatchSubmit(form: HTMLFormElement, submitter: HTMLElement | null = null) {
  const event = new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter })
  form.dispatchEvent(event)
  return event
}

async function flushFormGate(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
}

beforeEach(() => {
  submitted = []
  document.body.replaceChildren()
  HTMLFormElement.prototype.submit = function stubSubmit(this: HTMLFormElement) {
    submitted.push(this)
  }
})

afterEach(() => {
  uninstall?.()
  uninstall = undefined
  interceptor = undefined
  HTMLFormElement.prototype.submit = originalSubmit
  document.body.replaceChildren()
  vi.restoreAllMocks()
})
```

Add the first behavior tests:

```ts
describe('原生 submit 事件', () => {
  it('显式 form 通道会暂停原生提交，批准后只重放一次', async () => {
    const { confirm } = setup()
    const form = createForm()
    const hostSubmit = vi.fn()
    form.addEventListener('submit', hostSubmit)

    const event = dispatchSubmit(form)
    await flushFormGate()

    expect(event.defaultPrevented).toBe(true)
    expect(hostSubmit).toHaveBeenCalledTimes(1)
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm.mock.calls[0][0].request.channel).toBe('form')
    expect(submitted).toEqual([form])
  })

  it('requestSubmit 产生的 submit 事件进入同一条闸门', async () => {
    const { confirm } = setup()
    const form = createForm('<button name="intent" value="save">保存</button>')
    const button = form.elements.namedItem('intent') as HTMLButtonElement

    form.requestSubmit(button)
    await flushFormGate()

    expect(confirm).toHaveBeenCalledTimes(1)
    expect(submitted).toEqual([form])
  })
})

describe('直接 form.submit()', () => {
  it('同步返回 undefined，批准前不调用原实现，批准后延迟调用', async () => {
    let approve!: (allowed: boolean) => void
    setup({
      confirm: vi.fn(() => new Promise<boolean>(resolve => { approve = resolve }))
    })
    const form = createForm()

    const result = form.submit()

    expect(result).toBeUndefined()
    expect(submitted).toHaveLength(0)
    await Promise.resolve()
    approve(true)
    await flushFormGate()
    expect(submitted).toEqual([form])
  })
})
```

- [ ] **Step 2: 运行测试并确认旧实现失败**

Run:

```bash
npx vitest run packages/interceptor/src/form.spec.ts
```

Expected: FAIL；`confirm` 调用次数为 0、submit 事件未被阻止或直接 submit 立即调用桩，证明 `'form'` 当前未安装。

- [ ] **Step 3: 新增 form 模块的稳定内部契约**

Start `packages/interceptor/src/form.ts` with these types and constants:

```ts
import { markPatch, skipInactivePatches, type PatchLifecycle } from './patchLifecycle'
import type { InterceptedRequest } from './types'

const FORM_REGISTRY_SOURCE = '@wandkit/interceptor' as const
const FORM_REGISTRY = Symbol.for(`${FORM_REGISTRY_SOURCE}.form-registry`)

type FormGate = (request: InterceptedRequest) => Promise<boolean>
type FormMethod = 'GET' | 'POST' | 'DIALOG'

interface FormLayer {
  lifecycle: PatchLifecycle
  gate: FormGate
  nextId: () => string
}

interface FormEventContext {
  snapshot: FormSubmissionSnapshot
  layers: FormLayer[]
}

interface FormRegistry {
  source: typeof FORM_REGISTRY_SOURCE
  eventContexts: WeakMap<SubmitEvent, FormEventContext>
  replayingForms: WeakSet<HTMLFormElement>
}

interface FormStringEntry {
  name: string
  value: string
}

type FormEntryValueSnapshot =
  | { kind: 'string', value: string }
  | { kind: 'file', name: string, type: string, size: number, lastModified: number }

interface FormEntrySnapshot {
  name: string
  value: FormEntryValueSnapshot
}

interface FormSubmissionSnapshot {
  form: HTMLFormElement
  submitter: HTMLElement | null
  action: string
  method: FormMethod
  enctype: string
  target: string
  acceptCharset: string
  entries: readonly FormEntrySnapshot[]
  submitterEntries: readonly FormStringEntry[]
}

export function patchForm(
  view: Window & typeof globalThis,
  gate: FormGate,
  nextId: () => string
): () => void {
  return installFormLayer(view, { lifecycle: { active: true }, gate, nextId })
}
```

Implement `installFormLayer()` with these exact control-flow rules:

```ts
function installFormLayer(
  view: Window & typeof globalThis,
  layer: FormLayer
): () => void {
  const registry = getOrCreateRegistry(view)
  const prototype = view.HTMLFormElement?.prototype
  const previous = prototype?.submit
  if (!prototype || typeof previous !== 'function') return () => undefined

  const listener = (event: Event) => handleSubmitEvent(view, registry, layer, event)
  const patchedSubmit = markPatch(function patchedSubmit(this: HTMLFormElement): void {
    if (!layer.lifecycle.active || registry.replayingForms.has(this)) {
      previous.call(this)
      return
    }
    const snapshot = tryCaptureSnapshot(view, this, null)
    if (!snapshot || snapshot.method === 'DIALOG') {
      if (snapshot?.method === 'DIALOG') previous.call(this)
      return
    }
    void runDirectLayer(view, registry, layer, snapshot, () => previous.call(this))
  } as typeof previous, 'form-submit', layer.lifecycle, previous)

  let listenerInstalled = false
  try {
    prototype.submit = patchedSubmit
    view.addEventListener('submit', listener)
    listenerInstalled = true
  } catch (error) {
    layer.lifecycle.active = false
    if (listenerInstalled) view.removeEventListener('submit', listener)
    if (prototype.submit === patchedSubmit) prototype.submit = previous
    throw error
  }

  return () => {
    layer.lifecycle.active = false
    view.removeEventListener('submit', listener)
    if (prototype.submit === patchedSubmit) {
      prototype.submit = skipInactivePatches(previous, 'form-submit')
    }
  }
}
```

For the first green slice, add the following deliberately narrow POST-capable helpers. Tasks 3–5 replace their projection、multi-instance and replay details after the corresponding failing tests:

```ts
function getOrCreateRegistry(view: Window & typeof globalThis): FormRegistry {
  const target = view as Window & Record<PropertyKey, unknown>
  const existing = target[FORM_REGISTRY]
  if (existing) return existing as FormRegistry
  const registry: FormRegistry = {
    source: FORM_REGISTRY_SOURCE,
    eventContexts: new WeakMap(),
    replayingForms: new WeakSet()
  }
  Object.defineProperty(view, FORM_REGISTRY, { configurable: true, value: registry })
  return registry
}

function handleSubmitEvent(
  view: Window & typeof globalThis,
  registry: FormRegistry,
  layer: FormLayer,
  event: Event
): void {
  if (!layer.lifecycle.active || event.defaultPrevented) return
  const form = event.target
  if (!(form instanceof view.HTMLFormElement)) return
  const submitter = event instanceof view.SubmitEvent &&
    event.submitter instanceof view.HTMLElement
    ? event.submitter
    : null
  const snapshot = tryCaptureSnapshot(view, form, submitter)
  if (!snapshot) {
    event.preventDefault()
    return
  }
  if (snapshot.method === 'DIALOG') return
  event.preventDefault()
  const context: FormEventContext = { snapshot, layers: [layer] }
  registry.eventContexts.set(event as SubmitEvent, context)
  view.queueMicrotask(() => {
    void runEventContext(view, registry, event as SubmitEvent, context)
  })
}

async function runEventContext(
  view: Window & typeof globalThis,
  registry: FormRegistry,
  event: SubmitEvent,
  context: FormEventContext
): Promise<void> {
  try {
    const layer = context.layers[0]
    if (!layer.lifecycle.active || !snapshotMatches(view, context.snapshot)) return
    if (!(await layer.gate(toInterceptedRequest(context.snapshot, layer.nextId())))) return
    if (!layer.lifecycle.active || !snapshotMatches(view, context.snapshot)) return
    replaySubmission(view, registry, context.snapshot)
  } catch (_error) {
    // 表单事件没有可返回的 Promise；判定或快照异常按拒绝处理。
  } finally {
    registry.eventContexts.delete(event)
  }
}

async function runDirectLayer(
  view: Window & typeof globalThis,
  _registry: FormRegistry,
  layer: FormLayer,
  snapshot: FormSubmissionSnapshot,
  submit: () => void
): Promise<void> {
  try {
    if (!(await layer.gate(toInterceptedRequest(snapshot, layer.nextId())))) return
    if (!layer.lifecycle.active || !snapshotMatches(view, snapshot)) return
    submit()
  } catch (_error) {
    // 与 XHR 一致：直接 submit 无 Promise 返回，被拒或异常表现为不发送。
  }
}

function captureSnapshot(
  view: Window & typeof globalThis,
  form: HTMLFormElement,
  submitter: HTMLElement | null
): FormSubmissionSnapshot {
  const entries = Array.from(
    new view.FormData(form, submitter ?? undefined).entries(),
    ([name, value]): FormEntrySnapshot => ({
      name,
      value: typeof value === 'string'
        ? { kind: 'string', value }
        : {
            kind: 'file',
            name: value.name,
            type: value.type,
            size: value.size,
            lastModified: value.lastModified
          }
    })
  )
  const method = form.method.toUpperCase()
  return {
    form,
    submitter,
    action: new view.URL(form.action, view.document.baseURI).href,
    method: method === 'POST' || method === 'DIALOG' ? method : 'GET',
    enctype: form.enctype,
    target: form.target,
    acceptCharset: form.acceptCharset,
    entries,
    submitterEntries: []
  }
}

function tryCaptureSnapshot(
  view: Window & typeof globalThis,
  form: HTMLFormElement,
  submitter: HTMLElement | null
): FormSubmissionSnapshot | undefined {
  try {
    return captureSnapshot(view, form, submitter)
  } catch (_error) {
    return undefined
  }
}

function snapshotMatches(
  view: Window & typeof globalThis,
  expected: FormSubmissionSnapshot
): boolean {
  const current = tryCaptureSnapshot(view, expected.form, expected.submitter)
  return current !== undefined && JSON.stringify(current, snapshotJsonReplacer) ===
    JSON.stringify(expected, snapshotJsonReplacer)
}

function snapshotJsonReplacer(key: string, value: unknown): unknown {
  return key === 'form' || key === 'submitter' ? undefined : value
}

function toInterceptedRequest(
  snapshot: FormSubmissionSnapshot,
  id: string
): InterceptedRequest {
  const body = Object.fromEntries(snapshot.entries.map(entry => [
    entry.name,
    entry.value.kind === 'string' ? entry.value.value : entry.value
  ]))
  return {
    id,
    method: snapshot.method,
    url: snapshot.action,
    headers: snapshot.method === 'POST'
      ? { 'content-type': snapshot.enctype }
      : {},
    body: snapshot.method === 'POST' ? body : undefined,
    channel: 'form',
    timestamp: Date.now()
  }
}

function replaySubmission(
  view: Window & typeof globalThis,
  registry: FormRegistry,
  snapshot: FormSubmissionSnapshot
): void {
  registry.replayingForms.add(snapshot.form)
  try {
    view.HTMLFormElement.prototype.submit.call(snapshot.form)
  } finally {
    registry.replayingForms.delete(snapshot.form)
  }
}
```

This first slice intentionally does not apply submitter overrides、preserve duplicate fields、coordinate multiple event layers or add temporary hidden inputs. Those omissions are the failure causes driven by Tasks 3–5.

- [ ] **Step 4: 把 form 通道接到 interceptor 安装流程**

Add to `packages/interceptor/src/interceptor.ts`:

```ts
import { patchForm } from './form'
```

After Beacon installation, add:

```ts
if (channels.has('form')) restores.push(patchForm(view, gate, nextId))
```

Keep `DEFAULT_CHANNELS` unchanged as `['fetch', 'xhr', 'beacon']`.

- [ ] **Step 5: 运行首批用例直到绿色**

Run:

```bash
npx vitest run packages/interceptor/src/form.spec.ts
```

Expected: PASS；原生事件只触发一次宿主监听器，直接 submit 同步返回 `undefined` 且批准后才调用基线实现。

- [ ] **Step 6: 提交入口接通**

```bash
git branch --show-current
git add packages/interceptor/src/form.ts packages/interceptor/src/form.spec.ts packages/interceptor/src/interceptor.ts
git commit -m "fix: 接通原生表单拦截入口"
```

### Task 3: 完成快照、请求投影和 submitter 语义

**Files:**
- Modify: `packages/interceptor/src/form.ts`
- Modify: `packages/interceptor/src/form.spec.ts`

- [ ] **Step 1: 写 GET、POST 和 submitter override 失败测试**

Append tests that assert the exact request shape:

```ts
describe('表单请求投影', () => {
  it('GET 用有序字段替换 action query，文件使用文件名且 body 为空', async () => {
    const { confirm } = setup()
    const form = createForm('<input name="tag" value="a"><input name="tag" value="b">')
    form.method = 'get'
    form.action = '/search?stale=1#result'

    dispatchSubmit(form)
    await flushFormGate()

    const request = confirm.mock.calls[0][0].request
    expect(request).toMatchObject({ method: 'GET', headers: {}, body: undefined })
    expect(request.url).toBe(`${location.origin}/search?tag=a&tag=b#result`)
  })

  it('POST 保留 action query、enctype 和重复字段数组', async () => {
    const { confirm } = setup()
    const form = createForm('<input name="tag" value="a"><input name="tag" value="b">')
    form.action = '/api/users?source=form'
    form.enctype = 'multipart/form-data'

    dispatchSubmit(form)
    await flushFormGate()

    expect(confirm.mock.calls[0][0].request).toMatchObject({
      method: 'POST',
      url: `${location.origin}/api/users?source=form`,
      headers: { 'content-type': 'multipart/form-data' },
      body: { tag: ['a', 'b'] }
    })
  })

  it('submitter 的 formaction/formmethod/formenctype/formtarget 覆盖 form 配置', async () => {
    const { confirm } = setup()
    const form = createForm(`
      <input name="name" value="张三">
      <button name="intent" value="preview"
        formaction="/api/preview" formmethod="get"
        formenctype="text/plain" formtarget="preview-frame">预览</button>
    `)
    const button = form.querySelector('button') as HTMLButtonElement

    dispatchSubmit(form, button)
    await flushFormGate()

    expect(confirm.mock.calls[0][0].request).toMatchObject({
      method: 'GET',
      url: `${location.origin}/api/preview?name=%E5%BC%A0%E4%B8%89&intent=preview`
    })
  })
})
```

- [ ] **Step 2: 运行新增用例并确认失败**

Run:

```bash
npx vitest run packages/interceptor/src/form.spec.ts -t "表单请求投影"
```

Expected: FAIL；首个实现尚未完整处理 query、重复字段或 submitter override。

- [ ] **Step 3: 实现有效配置、entry 快照和投影**

Add these helpers to `packages/interceptor/src/form.ts`:

```ts
function captureSnapshot(
  view: Window & typeof globalThis,
  form: HTMLFormElement,
  submitter: HTMLElement | null
): FormSubmissionSnapshot {
  const entries = captureEntries(new view.FormData(form, submitter ?? undefined))
  const withoutSubmitter = submitter
    ? captureEntries(new view.FormData(form))
    : entries
  return {
    form,
    submitter,
    action: resolveAction(view, form, submitter),
    method: resolveMethod(form, submitter),
    enctype: resolveEnctype(form, submitter),
    target: resolveTarget(form, submitter),
    acceptCharset: form.acceptCharset,
    entries,
    submitterEntries: submitter ? subtractSubmitterEntries(entries, withoutSubmitter) : []
  }
}

function tryCaptureSnapshot(
  view: Window & typeof globalThis,
  form: HTMLFormElement,
  submitter: HTMLElement | null
): FormSubmissionSnapshot | undefined {
  try {
    return captureSnapshot(view, form, submitter)
  } catch (_error) {
    return undefined
  }
}

function resolveAction(
  view: Window & typeof globalThis,
  form: HTMLFormElement,
  submitter: HTMLElement | null
): string {
  const value = submitter?.hasAttribute('formaction')
    ? (submitter as HTMLButtonElement).formAction
    : form.action
  return new view.URL(value || view.document.URL, view.document.baseURI).href
}

function resolveMethod(form: HTMLFormElement, submitter: HTMLElement | null): FormMethod {
  const value = submitter?.hasAttribute('formmethod')
    ? (submitter as HTMLButtonElement).formMethod
    : form.method
  const normalized = value.toUpperCase()
  return normalized === 'POST' || normalized === 'DIALOG' ? normalized : 'GET'
}

function resolveEnctype(form: HTMLFormElement, submitter: HTMLElement | null): string {
  return submitter?.hasAttribute('formenctype')
    ? (submitter as HTMLButtonElement).formEnctype
    : form.enctype
}

function resolveTarget(form: HTMLFormElement, submitter: HTMLElement | null): string {
  return submitter?.hasAttribute('formtarget')
    ? (submitter as HTMLButtonElement).formTarget
    : form.target
}

function captureEntries(data: FormData): FormEntrySnapshot[] {
  return Array.from(data.entries(), ([name, value]) => ({
    name,
    value: typeof value === 'string'
      ? { kind: 'string' as const, value }
      : {
          kind: 'file' as const,
          name: value.name,
          type: value.type,
          size: value.size,
          lastModified: value.lastModified
        }
  }))
}

function toInterceptedRequest(snapshot: FormSubmissionSnapshot, id: string): InterceptedRequest {
  if (snapshot.method === 'GET') {
    const url = new URL(snapshot.action)
    url.search = ''
    snapshot.entries.forEach(entry => {
      url.searchParams.append(entry.name, entryValueForQuery(entry.value))
    })
    return {
      id,
      method: 'GET',
      url: url.href,
      headers: {},
      body: undefined,
      channel: 'form',
      timestamp: Date.now()
    }
  }

  return {
    id,
    method: 'POST',
    url: snapshot.action,
    headers: { 'content-type': snapshot.enctype },
    body: entriesToBody(snapshot.entries),
    channel: 'form',
    timestamp: Date.now()
  }
}
```

Implement `subtractSubmitterEntries()` with a serialized multiset count, preserving the order of unmatched entries from the with-submitter list. Throw if an unmatched entry is a file. Implement `entriesToBody()` with `Map<string, unknown[]>` and `Object.fromEntries()` so `__proto__` remains an own data property; emit a scalar for one value and an array for duplicates.

- [ ] **Step 4: 写普通 submitter、image 坐标、文件元数据和 formdata 动态字段测试**

Add tests using actual `FormData` output:

```ts
it('普通 submitter 字段会进入批准快照并通过 hidden input 重放', async () => {
  const { confirm } = setup()
  const form = createForm('<button name="intent" value="save">保存</button>')
  const button = form.querySelector('button') as HTMLButtonElement

  dispatchSubmit(form, button)
  await flushFormGate()

  expect(confirm.mock.calls[0][0].request.body).toEqual({ intent: 'save' })
  expect(submitted).toEqual([form])
})

it('文件仅投影元数据，formdata 动态字段参与快照', async () => {
  const { confirm } = setup()
  const form = createForm('<input type="file" name="attachment">')
  const input = form.elements.namedItem('attachment') as HTMLInputElement
  const file = new File(['abc'], 'proof.txt', { type: 'text/plain', lastModified: 123 })
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  form.addEventListener('formdata', event => {
    event.formData.set('token', 'stable')
  })

  dispatchSubmit(form)
  await flushFormGate()

  expect(confirm.mock.calls[0][0].request.body).toEqual({
    attachment: {
      kind: 'file', name: 'proof.txt', type: 'text/plain', size: 3, lastModified: 123
    },
    token: 'stable'
  })
})
```

For image submitter coordinates, construct the FormData behavior deterministically if jsdom does not provide click coordinates: spy on `window.FormData` only inside that test and return ordered entries containing `photo.x` and `photo.y`; assert both fields reach the request and replay hidden inputs.

- [ ] **Step 5: 逐个运行新增用例，先红后绿**

Run each new test by name before its implementation adjustment, then run the whole group:

```bash
npx vitest run packages/interceptor/src/form.spec.ts -t "普通 submitter 字段"
npx vitest run packages/interceptor/src/form.spec.ts -t "文件仅投影元数据"
npx vitest run packages/interceptor/src/form.spec.ts -t "image"
npx vitest run packages/interceptor/src/form.spec.ts -t "表单请求投影|submitter|文件|image"
```

Expected: each named test is observed FAIL before the corresponding implementation, then the final grouped run PASS.

- [ ] **Step 6: 提交快照和投影实现**

```bash
git branch --show-current
git add packages/interceptor/src/form.ts packages/interceptor/src/form.spec.ts
git commit -m "fix: 实现表单请求快照与投影"
```

### Task 4: 落实 SPA、拒绝、异常和快照失效语义

**Files:**
- Modify: `packages/interceptor/src/form.ts`
- Modify: `packages/interceptor/src/form.spec.ts`

- [ ] **Step 1: 写 SPA 和失败关闭路径测试**

Add:

```ts
describe('原生提交边界', () => {
  it('宿主已 preventDefault 的 SPA submit 不确认也不重放', async () => {
    const { confirm } = setup()
    const form = createForm()
    const host = vi.fn((event: SubmitEvent) => event.preventDefault())
    form.addEventListener('submit', host)

    dispatchSubmit(form)
    await flushFormGate()

    expect(host).toHaveBeenCalledTimes(1)
    expect(confirm).not.toHaveBeenCalled()
    expect(submitted).toHaveLength(0)
  })

  it('拒绝或 confirm 抛错都不提交', async () => {
    const form = createForm()
    setup({ confirm: vi.fn(async () => false) })
    dispatchSubmit(form)
    await flushFormGate()
    expect(submitted).toHaveLength(0)

    uninstall?.()
    setup({ confirm: vi.fn(async () => { throw new Error('dialog failed') }) })
    dispatchSubmit(form)
    await flushFormGate()
    expect(submitted).toHaveLength(0)
  })

  it('快照构建抛错时阻止原生提交且不调用 confirm', async () => {
    const { confirm } = setup()
    const form = createForm()
    vi.spyOn(window, 'FormData').mockImplementation(() => {
      throw new Error('formdata failed')
    })

    const event = dispatchSubmit(form)
    await flushFormGate()

    expect(event.defaultPrevented).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
    expect(submitted).toHaveLength(0)
  })

  it('method=dialog 不进入网络闸门', async () => {
    const { confirm } = setup()
    const form = createForm()
    form.setAttribute('method', 'dialog')

    const event = dispatchSubmit(form)
    form.submit()
    await flushFormGate()

    expect(event.defaultPrevented).toBe(false)
    expect(confirm).not.toHaveBeenCalled()
    expect(submitted).toEqual([form])
  })
})
```

- [ ] **Step 2: 运行边界测试并确认失败**

Run:

```bash
npx vitest run packages/interceptor/src/form.spec.ts -t "原生提交边界"
```

Expected: FAIL until event handler checks an existing shared context before `defaultPrevented`, skips host-prevented events, passes through dialog, and catches snapshot/gate failures.

- [ ] **Step 3: 实现事件上下文和失败关闭**

Use this event flow in `handleSubmitEvent()`:

```ts
function handleSubmitEvent(
  view: Window & typeof globalThis,
  registry: FormRegistry,
  layer: FormLayer,
  event: Event
): void {
  if (!layer.lifecycle.active || !(event instanceof view.SubmitEvent)) return
  const existing = registry.eventContexts.get(event)
  if (existing) {
    if (!existing.layers.includes(layer)) existing.layers.push(layer)
    return
  }
  if (event.defaultPrevented) return
  const form = event.target
  if (!(form instanceof view.HTMLFormElement)) return
  const submitter = event.submitter instanceof view.HTMLElement ? event.submitter : null
  const snapshot = tryCaptureSnapshot(view, form, submitter)
  if (!snapshot) {
    event.preventDefault()
    return
  }
  if (snapshot.method === 'DIALOG') return
  event.preventDefault()
  const context: FormEventContext = { snapshot, layers: [layer] }
  registry.eventContexts.set(event, context)
  view.queueMicrotask(() => {
    void runEventContext(view, registry, event, context).catch(() => undefined)
  })
}
```

`runEventContext()` must iterate a copy of `context.layers` from last to first, skip inactive layers, validate before and after every awaited gate, stop on `false` or any exception, and replay only if at least one active layer was actually approved. Delete the WeakMap entry in `finally`.

- [ ] **Step 4: 写等待期间变化的失败测试矩阵**

Use a deferred confirm and parameterized mutators:

```ts
it.each([
  ['字段值', (form: HTMLFormElement) => {
    (form.elements.namedItem('name') as HTMLInputElement).value = '李四'
  }],
  ['action', (form: HTMLFormElement) => { form.action = '/api/admins' }],
  ['method', (form: HTMLFormElement) => { form.method = 'get' }],
  ['enctype', (form: HTMLFormElement) => { form.enctype = 'text/plain' }],
  ['target', (form: HTMLFormElement) => { form.target = 'other-frame' }],
  ['acceptCharset', (form: HTMLFormElement) => { form.acceptCharset = 'iso-8859-1' }]
])('等待确认期间%s变化会使旧批准失效', async (_label, mutate) => {
  let approve!: (allowed: boolean) => void
  setup({ confirm: vi.fn(() => new Promise(resolve => { approve = resolve })) })
  const form = createForm()

  dispatchSubmit(form)
  await Promise.resolve()
  mutate(form)
  approve(true)
  await flushFormGate()

  expect(submitted).toHaveLength(0)
})
```

Add separate tests for file metadata change and submitter override/value change because their setup differs from ordinary attributes. Repeat the same invalidation expectations for direct `form.submit()`.

- [ ] **Step 5: 运行变化测试并实现逐字段快照比较**

Run each test first and observe FAIL, then implement:

```ts
function snapshotMatches(
  view: Window & typeof globalThis,
  expected: FormSubmissionSnapshot
): boolean {
  const current = tryCaptureSnapshot(view, expected.form, expected.submitter)
  return current !== undefined && snapshotsEqual(expected, current)
}
```

`snapshotsEqual()` must compare form and submitter identity; action、method、enctype、target、acceptCharset; entry count/order/name/value kind/string; file name/type/size/lastModified; and submitter entry count/order/name/value. It must not compare `File` object identity.

Run:

```bash
npx vitest run packages/interceptor/src/form.spec.ts -t "变化会使旧批准失效|文件元数据|submitter"
```

Expected: PASS；变化后不重新确认、不提交新内容。

- [ ] **Step 6: 提交边界与竞态修复**

```bash
git branch --show-current
git add packages/interceptor/src/form.ts packages/interceptor/src/form.spec.ts
git commit -m "fix: 绑定表单批准与提交快照"
```

### Task 5: 完成安全重放、多实例和卸载生命周期

**Files:**
- Modify: `packages/interceptor/src/form.ts`
- Modify: `packages/interceptor/src/form.spec.ts`

- [ ] **Step 1: 写多实例顺序和卸载失败测试**

Add tests that create two interceptors A then B with independent confirms:

```ts
it('多个 form 实例按 B → A → browser 顺序治理同一 submit 事件', async () => {
  const order: string[] = []
  const instanceA = createInterceptor({
    policy: { defaultForSafeMethods: 'confirm' },
    attribution: createStaticAttribution(true),
    confirm: vi.fn(async () => { order.push('A'); return true }),
    channels: ['form']
  })
  const instanceB = createInterceptor({
    policy: { defaultForSafeMethods: 'confirm' },
    attribution: createStaticAttribution(true),
    confirm: vi.fn(async () => { order.push('B'); return true }),
    channels: ['form']
  })
  const uninstallA = instanceA.install()
  const uninstallB = instanceB.install()
  const form = createForm()

  try {
    dispatchSubmit(form)
    await flushFormGate()
    expect(order).toEqual(['B', 'A'])
    expect(submitted).toEqual([form])
  } finally {
    uninstallB()
    uninstallA()
  }
})
```

Add explicit cases for: uninstall A before B, LIFO uninstall, pending confirm then uninstall, stale wrapper reference after uninstall, old uninstall closure after reinstall, and both layers inactive before the microtask. Each case must assert inactive confirms are not called and baseline submit is restored only when the last active form wrapper is removed.

- [ ] **Step 2: 逐个运行多实例用例并确认失败**

Run:

```bash
npx vitest run packages/interceptor/src/form.spec.ts -t "多个 form 实例"
npx vitest run packages/interceptor/src/form.spec.ts -t "卸载|旧引用|重装"
```

Expected: FAIL before shared registry/lifecycle behavior is complete.

- [ ] **Step 3: 实现结构校验后的共享注册表**

Implement:

```ts
function getOrCreateRegistry(view: Window & typeof globalThis): FormRegistry {
  let value: unknown
  try {
    value = (view as Window & Record<PropertyKey, unknown>)[FORM_REGISTRY]
  } catch (error) {
    throw error
  }
  if (value !== undefined) {
    if (!isFormRegistry(value)) throw new TypeError('Incompatible form interceptor registry.')
    return value
  }
  const registry: FormRegistry = {
    source: FORM_REGISTRY_SOURCE,
    eventContexts: new WeakMap(),
    replayingForms: new WeakSet()
  }
  Object.defineProperty(view, FORM_REGISTRY, {
    configurable: true,
    value: registry
  })
  return registry
}

function isFormRegistry(value: unknown): value is FormRegistry {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<FormRegistry>
  return candidate.source === FORM_REGISTRY_SOURCE &&
    candidate.eventContexts instanceof WeakMap &&
    candidate.replayingForms instanceof WeakSet
}
```

Do not overwrite incompatible external values. Treat property getters that throw as installation errors.

- [ ] **Step 4: 写外部 wrapper 和安全重放测试**

Add a post-install external wrapper that calls the captured interceptor wrapper. Assert approved replay reaches the external wrapper once, does not gate twice, and temporary action/method/enctype/target plus hidden submitter fields are restored even when the external wrapper throws.

Use assertions equivalent to:

```ts
expect(externalSubmit).toHaveBeenCalledTimes(1)
expect(confirm).toHaveBeenCalledTimes(1)
expect(form.getAttribute('action')).toBe(originalActionAttribute)
expect(form.querySelectorAll('input[data-wandkit-replay]')).toHaveLength(0)
```

- [ ] **Step 5: 实现安全重放**

Implement `replaySubmission()` with a synchronous `try/finally`:

```ts
function replaySubmission(
  view: Window & typeof globalThis,
  registry: FormRegistry,
  snapshot: FormSubmissionSnapshot
): void {
  const form = snapshot.form
  const saved = saveAttributes(form, ['action', 'method', 'enctype', 'target'])
  const hidden = snapshot.submitterEntries.map(entry => {
    const input = view.document.createElement('input')
    input.type = 'hidden'
    input.name = entry.name
    input.value = entry.value
    input.dataset.wandkitReplay = ''
    form.append(input)
    return input
  })
  try {
    form.setAttribute('action', snapshot.action)
    form.setAttribute('method', snapshot.method.toLowerCase())
    form.setAttribute('enctype', snapshot.enctype)
    form.setAttribute('target', snapshot.target)
    registry.replayingForms.add(form)
    view.HTMLFormElement.prototype.submit.call(form)
  } finally {
    registry.replayingForms.delete(form)
    hidden.forEach(input => input.remove())
    restoreAttributes(form, saved)
  }
}
```

`saveAttributes()` must record both `hasAttribute` and raw `getAttribute` values. `restoreAttributes()` must restore raw text for present attributes and remove attributes that were originally absent.

- [ ] **Step 6: 运行生命周期和 form 全量测试**

Run:

```bash
npx vitest run packages/interceptor/src/form.spec.ts
npx vitest run packages/interceptor/src/interceptor.spec.ts packages/interceptor/src/channels.spec.ts
```

Expected: PASS；form 多实例顺序为 B → A，Fetch/XHR/Beacon 生命周期测试无回归。

- [ ] **Step 7: 提交多实例与重放实现**

```bash
git branch --show-current
git add packages/interceptor/src/form.ts packages/interceptor/src/form.spec.ts
git commit -m "fix: 完善表单多实例与安全重放"
```

### Task 6: 让 interceptor 安装具备事务回滚

**Files:**
- Modify: `packages/interceptor/src/interceptor.ts`
- Modify: `packages/interceptor/src/form.spec.ts`

- [ ] **Step 1: 写 form 安装失败后的全通道回滚测试**

Add a test that captures Fetch、XHR open/send、Beacon and form submit baselines, then makes `window.addEventListener('submit', ...)` throw:

```ts
it('form 安装失败会回滚此前安装的所有通道并允许重试', () => {
  const baseline = {
    fetch: window.fetch,
    open: XMLHttpRequest.prototype.open,
    send: XMLHttpRequest.prototype.send,
    beacon: navigator.sendBeacon,
    submit: HTMLFormElement.prototype.submit
  }
  const instance = createInterceptor({
    policy: {},
    attribution: createStaticAttribution(true),
    confirm: vi.fn(async () => true),
    channels: ['fetch', 'xhr', 'beacon', 'form']
  })
  const addEventListener = window.addEventListener.bind(window)
  vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
    if (type === 'submit') throw new Error('submit listener denied')
    return addEventListener(type, listener, options)
  })

  expect(() => instance.install()).toThrow('submit listener denied')
  expect(instance.installed).toBe(false)
  expect(window.fetch).toBe(baseline.fetch)
  expect(XMLHttpRequest.prototype.open).toBe(baseline.open)
  expect(XMLHttpRequest.prototype.send).toBe(baseline.send)
  expect(navigator.sendBeacon).toBe(baseline.beacon)
  expect(HTMLFormElement.prototype.submit).toBe(baseline.submit)
})
```

- [ ] **Step 2: 运行该测试并确认失败**

Run:

```bash
npx vitest run packages/interceptor/src/form.spec.ts -t "form 安装失败"
```

Expected: FAIL；当前 `install()` 在异常后仍是 installed 或保留已安装通道。

- [ ] **Step 3: 实现逆序事务回滚**

Replace the channel installation block in `createInterceptor().install()` with:

```ts
try {
  if (channels.has('fetch')) restores.push(patchFetch(view, gate, nextId))
  if (channels.has('xhr')) restores.push(patchXhr(view, gate, nextId))
  if (channels.has('beacon')) restores.push(patchBeacon(view, options, nextId))
  if (channels.has('form')) restores.push(patchForm(view, gate, nextId))
} catch (error) {
  for (let index = restores.length - 1; index >= 0; index -= 1) {
    try {
      restores[index]()
    } catch (_restoreError) {
      // 保留并重抛触发安装失败的原始错误。
    }
  }
  installed = false
  throw error
}
```

Change normal uninstall to run restores from last to first. Keep the per-install `cleaned` closure so a stale uninstall function cannot affect a later reinstall.

- [ ] **Step 4: 覆盖注册表冲突和属性读取异常**

Add one test with `Object.defineProperty(window, Symbol.for('@wandkit/interceptor.form-registry'), { value: {}, configurable: true })` and one with a throwing getter. Both must throw from install, restore earlier channels, leave the external property untouched, and report `installed === false`. Delete only the properties created by the tests in their `finally` blocks.

- [ ] **Step 5: 运行事务与全包测试**

Run:

```bash
npx vitest run packages/interceptor/src/form.spec.ts -t "安装失败|注册表"
npx vitest run packages/interceptor/src
npm run typecheck --workspace @wandkit/interceptor
```

Expected: PASS，类型检查退出码为 0。

- [ ] **Step 6: 提交事务安装修复**

```bash
git branch --show-current
git add packages/interceptor/src/interceptor.ts packages/interceptor/src/form.spec.ts
git commit -m "fix: 事务化安装请求拦截通道"
```

### Task 7: 更新接入文档和限制说明

**Files:**
- Modify: `packages/interceptor/README.md`

- [ ] **Step 1: 把三通道文档更新为四通道**

Replace `## 三条通道` with `## 四条通道`, add this row, and remove form from “未覆盖”:

```md
| `<form>` | 显式开启后暂停原生 submit；直接 `form.submit()` 内部延迟 | **破坏直接 submit 的同步发送时序** |
```

- [ ] **Step 2: 增加显式开启示例**

Add:

```ts
const interceptor = createInterceptor({
  policy,
  attribution,
  confirm,
  channels: ['fetch', 'xhr', 'beacon', 'form']
})
```

State that form remains excluded from default channels and must be enabled explicitly.

- [ ] **Step 3: 写清楚 form 的行为边界**

Document all of the following in one `### 原生表单通道` section:

- host-prevented SPA submit is skipped and remains governed by its Fetch/XHR request;
- native submit、`requestSubmit(submitter)` and direct `form.submit()` are covered;
- approved replay does not dispatch a second submit event;
- direct submit returns `undefined` synchronously but the real submit is delayed;
- fields or effective submission configuration changing while awaiting approval invalidates the old continuation;
- multiple instances execute from newest to oldest;
- `method=dialog` is not treated as a network request;
- listeners registered on Window after the interceptor may run too late to be recognized as SPA ownership;
- iframe realms require a separate interceptor with that Window passed as `view`.

- [ ] **Step 4: 写清楚 formdata 幂等要求**

Add this explicit warning:

```md
构建初始快照、批准前复核和计算 submitter 字段都会调用浏览器的 `FormData` 算法，
因此 `formdata` 监听器可能执行多次。处理器必须幂等；计费、埋点或其他不可重复副作用
不能直接放在 `formdata` 监听器中。
```

- [ ] **Step 5: 校验 README 并提交**

Run:

```bash
git diff --check
```

Expected: no output, exit code 0.

```bash
git branch --show-current
git add packages/interceptor/README.md
git commit -m "fix: 补充原生表单拦截文档"
```

### Task 8: 分层验证、浏览器冒烟和交付记录

**Files:**
- Create: `docs/fix_20260801_原生表单拦截/test-results.md`
- Create: `docs/fix_20260801_原生表单拦截/review.md`
- Verify: all changed production, test and documentation files

- [ ] **Step 1: 运行 form 定向测试**

Run:

```bash
npx vitest run packages/interceptor/src/form.spec.ts
```

Expected: PASS；记录测试文件数、用例数、耗时和退出码。

- [ ] **Step 2: 运行 interceptor 包测试和类型检查**

Run:

```bash
npx vitest run packages/interceptor/src
npm run typecheck --workspace @wandkit/interceptor
```

Expected: PASS，两个命令退出码均为 0。

- [ ] **Step 3: 运行仓库完整门槛**

Run:

```bash
npm run verify
git diff --check
```

Expected: 全仓测试、所有 workspace 类型检查和 build 均 PASS；`git diff --check` 无输出。

- [ ] **Step 4: 尝试真实浏览器冒烟**

First inspect without installing new dependencies:

```bash
npx playwright --version
```

If a browser executable is already available, use a temporary development page and store all artifacts under:

```text
.playwright/fix_20260801_原生表单拦截-20260801/
```

Cover native GET、native POST、`requestSubmit(submitter)` and SPA `preventDefault()`. Stop any server started by this task and verify its port is released. If Playwright or its browser is unavailable, record the exact command/error and mark browser smoke as skipped; do not install dependencies or claim it ran.

- [ ] **Step 5: 写测试结果记录**

Create `test-results.md` with: red-phase commands and expected failures, green-phase commands and pass counts, full `npm run verify` output summary, browser smoke result/skip reason, and cleanup confirmation.

- [ ] **Step 6: 做第二轮全 diff 自审并写评审记录**

Inspect:

```bash
git diff main...HEAD -- packages/interceptor/src packages/interceptor/README.md docs/fix_20260801_原生表单拦截
git status --short
```

In `review.md`, explicitly check: default channels unchanged; no new public export; GET/POST projection contract; SPA skip; no second submit event; snapshot invalidation; B → A order; uninstall/external wrapper semantics; install rollback; formdata warning; no unrelated changes.

- [ ] **Step 7: 提交验证和评审记录**

```bash
git branch --show-current
git add docs/fix_20260801_原生表单拦截/test-results.md docs/fix_20260801_原生表单拦截/review.md
git commit -m "fix: 记录原生表单拦截验证结果"
```

- [ ] **Step 8: 最终验证提交态并推送独立分支**

Run the final evidence-producing commands again after the documentation commit:

```bash
npm run verify
git diff --check
git status --short
git branch -vv
git branch --show-current
```

Expected: verify PASS、diff check PASS、工作区干净、当前分支为 `fix_20260801_原生表单拦截`，且分支没有错误跟踪 `origin/main`。

Push exactly:

```bash
git push -u origin fix_20260801_原生表单拦截:fix_20260801_原生表单拦截
```

Create one independent PR targeting `main`; include problem、behavior contract、test evidence and known limitations. Do not merge it automatically.
