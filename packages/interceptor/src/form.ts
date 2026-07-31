import { markPatch, skipInactivePatches, type PatchLifecycle } from './patchLifecycle'
import type { InterceptedRequest } from './types'

type FormGate = (request: InterceptedRequest) => Promise<boolean>

export function patchForm(
  view: Window & typeof globalThis,
  gate: FormGate,
  nextId: () => string
): () => void {
  const prototype = view.HTMLFormElement?.prototype
  const previous = prototype?.submit
  if (!prototype || typeof previous !== 'function') return () => undefined
  const lifecycle: PatchLifecycle = { active: true }
  const replayingForms = new WeakSet<HTMLFormElement>()

  const listener = (event: Event) => {
    if (!lifecycle.active || event.defaultPrevented) return
    const form = event.target
    if (!(form instanceof view.HTMLFormElement)) return

    let request: InterceptedRequest
    try {
      request = toInterceptedRequest(
        view,
        form,
        event instanceof view.SubmitEvent ? event.submitter : null,
        nextId()
      )
    } catch (_error) {
      event.preventDefault()
      return
    }

    event.preventDefault()
    void gate(request).then(allowed => {
      if (allowed && lifecycle.active) replaySubmission(view, replayingForms, form)
    }).catch(() => undefined)
  }

  const patchedSubmit = markPatch(function patchedSubmit(this: HTMLFormElement): void {
    if (!lifecycle.active || replayingForms.has(this)) {
      previous.call(this)
      return
    }

    let request: InterceptedRequest
    try {
      request = toInterceptedRequest(view, this, null, nextId())
    } catch (_error) {
      return
    }

    void gate(request).then(allowed => {
      if (allowed && lifecycle.active) previous.call(this)
    }).catch(() => undefined)
  } as typeof previous, 'form-submit', lifecycle, previous)

  prototype.submit = patchedSubmit
  view.addEventListener('submit', listener)

  return () => {
    lifecycle.active = false
    view.removeEventListener('submit', listener)
    if (prototype.submit === patchedSubmit) {
      prototype.submit = skipInactivePatches(previous, 'form-submit')
    }
  }
}

function toInterceptedRequest(
  view: Window & typeof globalThis,
  form: HTMLFormElement,
  submitter: HTMLElement | null,
  id: string
): InterceptedRequest {
  const data = new view.FormData(form, submitter ?? undefined)
  const method = resolveMethod(form, submitter)
  const action = resolveAction(view, form, submitter)
  if (method === 'GET') {
    const url = new view.URL(action)
    url.search = ''
    data.forEach((value, name) => {
      url.searchParams.append(name, typeof value === 'string' ? value : value.name)
    })
    return {
      id,
      method,
      url: url.href,
      headers: {},
      body: undefined,
      channel: 'form',
      timestamp: Date.now()
    }
  }
  return {
    id,
    method,
    url: action,
    headers: { 'content-type': form.enctype },
    body: formDataToBody(data),
    channel: 'form',
    timestamp: Date.now()
  }
}

function formDataToBody(data: FormData): Record<string, FormDataEntryValue> {
  const body: Record<string, FormDataEntryValue> = {}
  data.forEach((value, name) => {
    body[name] = value
  })
  return body
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

function replaySubmission(
  view: Window & typeof globalThis,
  replayingForms: WeakSet<HTMLFormElement>,
  form: HTMLFormElement
): void {
  replayingForms.add(form)
  try {
    view.HTMLFormElement.prototype.submit.call(form)
  } finally {
    replayingForms.delete(form)
  }
}
