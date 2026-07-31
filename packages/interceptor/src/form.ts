import { markPatch, skipInactivePatches, type PatchLifecycle } from './patchLifecycle'
import type { InterceptedRequest } from './types'

const FORM_REGISTRY_SOURCE = '@toolairlock/interceptor' as const
const FORM_REGISTRY = Symbol.for(`${FORM_REGISTRY_SOURCE}.form-registry`)

type FormGate = (request: InterceptedRequest) => Promise<boolean>

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

interface FormFileSnapshot {
  kind: 'file'
  name: string
  type: string
  size: number
  lastModified: number
}

type FormEntryValueSnapshot =
  | { kind: 'string', value: string }
  | FormFileSnapshot

type FormBodyValue = string | FormFileSnapshot

interface FormEntrySnapshot {
  name: string
  value: FormEntryValueSnapshot
}

interface FormStringEntry {
  name: string
  value: string
}

interface FormSubmissionSnapshot {
  form: HTMLFormElement
  submitter: HTMLElement | null
  action: string
  method: string
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
  const prototype = view.HTMLFormElement?.prototype
  const previous = prototype?.submit
  if (!prototype || typeof previous !== 'function') return () => undefined
  const registry = getOrCreateRegistry(view)
  const lifecycle: PatchLifecycle = { active: true }
  const layer: FormLayer = { lifecycle, gate, nextId }

  const listener = (event: Event) => {
    handleSubmitEvent(view, registry, layer, event)
  }

  const patchedSubmit = markPatch(function patchedSubmit(this: HTMLFormElement): void {
    if (!lifecycle.active || registry.replayingForms.has(this)) {
      previous.call(this)
      return
    }

    let snapshot: FormSubmissionSnapshot
    try {
      snapshot = captureSnapshot(view, this, null)
    } catch (_error) {
      return
    }
    if (snapshot.method === 'DIALOG') {
      previous.call(this)
      return
    }

    void gate(toInterceptedRequest(view, snapshot, nextId())).then(allowed => {
      if (!allowed || !lifecycle.active || !snapshotMatches(view, snapshot)) return
      try {
        previous.call(this)
      } catch (error) {
        reportAsyncError(view, error)
      }
    }, () => undefined)
  } as typeof previous, 'form-submit', lifecycle, previous)

  try {
    prototype.submit = patchedSubmit
    view.addEventListener('submit', listener)
  } catch (error) {
    lifecycle.active = false
    view.removeEventListener('submit', listener)
    if (prototype.submit === patchedSubmit) {
      prototype.submit = skipInactivePatches(previous, 'form-submit')
    }
    throw error
  }

  return () => {
    lifecycle.active = false
    view.removeEventListener('submit', listener)
    if (prototype.submit === patchedSubmit) {
      prototype.submit = skipInactivePatches(previous, 'form-submit')
    }
  }
}

function reportAsyncError(
  view: Window & typeof globalThis,
  error: unknown
): void {
  view.queueMicrotask(() => { throw error })
}

function getOrCreateRegistry(view: Window & typeof globalThis): FormRegistry {
  const target = view as Window & typeof globalThis & Record<PropertyKey, unknown>
  const existing = target[FORM_REGISTRY]
  if (existing !== undefined) {
    if (!isFormRegistry(existing)) {
      throw new TypeError('Incompatible form interceptor registry.')
    }
    return existing
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

  let snapshot: FormSubmissionSnapshot
  try {
    snapshot = captureSnapshot(
      view,
      form,
      event.submitter instanceof view.HTMLElement ? event.submitter : null
    )
  } catch (_error) {
    event.preventDefault()
    return
  }
  if (snapshot.method === 'DIALOG') return

  event.preventDefault()
  const context: FormEventContext = { snapshot, layers: [layer] }
  registry.eventContexts.set(event, context)
  view.queueMicrotask(() => {
    void runEventContext(view, registry, event, context)
  })
}

async function runEventContext(
  view: Window & typeof globalThis,
  registry: FormRegistry,
  event: SubmitEvent,
  context: FormEventContext
): Promise<void> {
  let approvedLayer = false
  try {
    const layers = [...context.layers]
    for (let index = layers.length - 1; index >= 0; index -= 1) {
      const layer = layers[index]
      if (!layer.lifecycle.active) continue
      if (!snapshotMatches(view, context.snapshot)) return
      const allowed = await layer.gate(
        toInterceptedRequest(view, context.snapshot, layer.nextId())
      )
      if (!allowed || !layer.lifecycle.active || !snapshotMatches(view, context.snapshot)) {
        return
      }
      approvedLayer = true
    }
  } catch (_error) {
    // 表单事件没有可返回的 Promise；判定或快照异常按拒绝处理。
    return
  } finally {
    registry.eventContexts.delete(event)
  }
  if (!approvedLayer) return
  try {
    replaySubmission(view, registry, context.snapshot)
  } catch (error) {
    reportAsyncError(view, error)
  }
}

function toInterceptedRequest(
  view: Window & typeof globalThis,
  snapshot: FormSubmissionSnapshot,
  id: string
): InterceptedRequest {
  if (snapshot.method === 'GET') {
    const url = new view.URL(snapshot.action)
    url.search = ''
    snapshot.entries.forEach(entry => {
      url.searchParams.append(
        entry.name,
        entry.value.kind === 'string' ? entry.value.value : entry.value.name
      )
    })
    return {
      id,
      method: snapshot.method,
      url: url.href,
      headers: {},
      body: undefined,
      channel: 'form',
      timestamp: Date.now()
    }
  }
  return {
    id,
    method: snapshot.method,
    url: snapshot.action,
    headers: { 'content-type': snapshot.enctype },
    body: entriesToBody(snapshot.entries),
    channel: 'form',
    timestamp: Date.now()
  }
}

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
    submitterEntries: submitter
      ? subtractSubmitterEntries(entries, withoutSubmitter)
      : []
  }
}

function captureEntries(data: FormData): FormEntrySnapshot[] {
  const entries: FormEntrySnapshot[] = []
  data.forEach((value, name) => {
    entries.push({ name, value: snapshotFormDataValue(value) })
  })
  return entries
}

function subtractSubmitterEntries(
  withSubmitter: readonly FormEntrySnapshot[],
  withoutSubmitter: readonly FormEntrySnapshot[]
): FormStringEntry[] {
  const remaining = new Map<string, number>()
  withoutSubmitter.forEach(entry => {
    const key = serializeEntry(entry)
    remaining.set(key, (remaining.get(key) ?? 0) + 1)
  })

  const result: FormStringEntry[] = []
  withSubmitter.forEach(entry => {
    const key = serializeEntry(entry)
    const count = remaining.get(key) ?? 0
    if (count > 0) {
      remaining.set(key, count - 1)
      return
    }
    if (entry.value.kind !== 'string') {
      throw new TypeError('A form submitter contributed a non-string value.')
    }
    result.push({ name: entry.name, value: entry.value.value })
  })
  return result
}

function serializeEntry(entry: FormEntrySnapshot): string {
  return JSON.stringify([entry.name, entry.value])
}

function snapshotMatches(
  view: Window & typeof globalThis,
  expected: FormSubmissionSnapshot
): boolean {
  try {
    const current = captureSnapshot(view, expected.form, expected.submitter)
    return snapshotsEqual(expected, current)
  } catch (_error) {
    return false
  }
}

function snapshotsEqual(
  left: FormSubmissionSnapshot,
  right: FormSubmissionSnapshot
): boolean {
  return left.form === right.form &&
    left.submitter === right.submitter &&
    left.action === right.action &&
    left.method === right.method &&
    left.enctype === right.enctype &&
    left.target === right.target &&
    left.acceptCharset === right.acceptCharset &&
    entriesEqual(left.entries, right.entries) &&
    stringEntriesEqual(left.submitterEntries, right.submitterEntries)
}

function stringEntriesEqual(
  left: readonly FormStringEntry[],
  right: readonly FormStringEntry[]
): boolean {
  return left.length === right.length && left.every((entry, index) =>
    entry.name === right[index]?.name && entry.value === right[index]?.value
  )
}

function entriesEqual(
  left: readonly FormEntrySnapshot[],
  right: readonly FormEntrySnapshot[]
): boolean {
  return left.length === right.length && left.every((entry, index) => {
    const other = right[index]
    if (!other || entry.name !== other.name || entry.value.kind !== other.value.kind) {
      return false
    }
    if (entry.value.kind === 'string' && other.value.kind === 'string') {
      return entry.value.value === other.value.value
    }
    return entry.value.kind === 'file' && other.value.kind === 'file' &&
      entry.value.name === other.value.name &&
      entry.value.type === other.value.type &&
      entry.value.size === other.value.size &&
      entry.value.lastModified === other.value.lastModified
  })
}

function entriesToBody(
  entries: readonly FormEntrySnapshot[]
): Record<string, FormBodyValue | FormBodyValue[]> {
  const collected = new Map<string, FormBodyValue[]>()
  entries.forEach(entry => {
    const value: FormBodyValue = entry.value.kind === 'string'
      ? entry.value.value
      : entry.value
    const values = collected.get(entry.name)
    if (values) values.push(value)
    else collected.set(entry.name, [value])
  })
  return Object.fromEntries(Array.from(collected, ([name, values]) => [
    name,
    values.length === 1 ? values[0] : values
  ]))
}

function snapshotFormDataValue(value: FormDataEntryValue): FormEntryValueSnapshot {
  if (typeof value === 'string') return { kind: 'string', value }
  return {
    kind: 'file',
    name: value.name,
    type: value.type,
    size: value.size,
    lastModified: value.lastModified
  }
}

function resolveAction(
  view: Window & typeof globalThis,
  form: HTMLFormElement,
  submitter: HTMLElement | null
): string {
  const override = submitter?.getAttribute('formaction')
  const value = override !== null && override !== undefined ? override : form.action
  return new view.URL(value || view.document.URL, view.document.baseURI).href
}

function resolveMethod(
  form: HTMLFormElement,
  submitter: HTMLElement | null
): string {
  const override = submitter?.getAttribute('formmethod')
  const value = override !== null && override !== undefined ? override : form.method
  const normalized = value.toUpperCase()
  return normalized === 'POST' || normalized === 'DIALOG' ? normalized : 'GET'
}

function resolveEnctype(
  form: HTMLFormElement,
  submitter: HTMLElement | null
): string {
  const override = submitter?.getAttribute('formenctype')
  const value = (override !== null && override !== undefined ? override : form.enctype)
    .toLowerCase()
  return value === 'multipart/form-data' || value === 'text/plain'
    ? value
    : 'application/x-www-form-urlencoded'
}

function resolveTarget(
  form: HTMLFormElement,
  submitter: HTMLElement | null
): string {
  const override = submitter?.getAttribute('formtarget')
  return override !== null && override !== undefined ? override : form.target
}

function replaySubmission(
  view: Window & typeof globalThis,
  registry: FormRegistry,
  snapshot: FormSubmissionSnapshot
): void {
  const form = snapshot.form
  const savedAttributes = ['action', 'method', 'enctype', 'target'].map(name => ({
    name,
    present: form.hasAttribute(name),
    value: form.getAttribute(name)
  }))
  const hidden: HTMLInputElement[] = []
  registry.replayingForms.add(form)
  try {
    form.setAttribute('action', snapshot.action)
    form.setAttribute('method', snapshot.method.toLowerCase())
    form.setAttribute('enctype', snapshot.enctype)
    form.setAttribute('target', snapshot.target)
    snapshot.submitterEntries.forEach(entry => {
      const input = view.document.createElement('input')
      input.type = 'hidden'
      input.name = entry.name
      input.value = entry.value
      input.dataset.toolairlockReplay = ''
      form.append(input)
      hidden.push(input)
    })
    view.HTMLFormElement.prototype.submit.call(form)
  } finally {
    registry.replayingForms.delete(form)
    hidden.forEach(input => input.remove())
    savedAttributes.forEach(attribute => {
      if (attribute.present) form.setAttribute(attribute.name, attribute.value ?? '')
      else form.removeAttribute(attribute.name)
    })
  }
}
