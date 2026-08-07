import { evaluateRequest } from './policy'
import { patchForm } from './form'
import {
  markPatch,
  skipInactivePatches,
  type PatchLifecycle
} from './patchLifecycle'
import type {
  AttributionPort,
  AuthorizationScope,
  InterceptedRequest,
  InterceptionPolicy,
  RequestChannel,
  RequestDisclosure,
  RequestRule,
  Verdict
} from './types'

/**
 * 请求被用户拒绝，或闸门自身无法完成判定。
 *
 * 单独定义一个类而不是普通 Error，是为了让调用方能把「被拒」与「网络挂了」分开——
 * 与核心包用 `cancelled` 标记而非文案判定取消，是同一条原则。靠比对 message 文本
 * 区分，会在文案被翻译的那一刻失效。
 */
export class RequestDeniedError extends Error {
  constructor(
    readonly request: InterceptedRequest,
    message = 'Request was not approved.'
  ) {
    super(message)
    this.name = 'RequestDeniedError'
  }
}

/**
 * 拦截器向宿主要一个「拿到判定就去问人」的回调。
 *
 * 刻意不直接依赖 `AgentRuntime` 或 UI 包：判定属于本包，而「怎么问人」属于宿主
 * ——它可能复用运行时的确认队列，也可能是自己的弹窗。保持这层解耦，本包才能在
 * 没有 Agent 运行时的页面上单独使用（治理宿主自有代码的写操作）。
 *
 * @returns 用户是否批准。抛异常按**拒绝**处理——问不出结果时放行，等于把闸门
 *   建在一个可以抛错的回调上。
 */
export type ConfirmRequestHandler = (input: {
  request: InterceptedRequest
  risk: 'write' | 'destructive'
  disclosure?: RequestDisclosure
}) => Promise<boolean>

export interface InterceptorOptions {
  policy: InterceptionPolicy
  attribution: AttributionPort
  authorization?: AuthorizationScope
  confirm: ConfirmRequestHandler
  /**
   * 要接管的通道，缺省全部（`form` 除外，需显式开启以免与宿主表单逻辑打架）。
   *
   * `beacon` 无法挂起，见 {@link InterceptorOptions.onUnholdableRequest}。
   */
  channels?: readonly RequestChannel[]
  /**
   * 命中确认、但所在通道无法挂起时的回调（当前仅 `sendBeacon`）。
   *
   * 默认行为是**拒发并返回 false**：放行等于让一个该确认的写操作直接溜出去。
   * 但这会改变宿主既有行为，因此暴露出来让接入方知情并可上报。
   */
  onUnholdableRequest?(request: InterceptedRequest): void
  /** 每次判定后回调，供宿主写入 trace。 */
  onVerdict?(request: InterceptedRequest, verdict: Verdict): void
  /** 注入 window，便于测试。缺省用全局。 */
  view?: Window & typeof globalThis
}

/**
 * 已安装的拦截器。
 *
 * `install` 必须幂等且可完全卸载：SPA 热更新、测试用例之间都要能干净地装回原样，
 * 否则会叠出多层 patch，一个请求被反复判定。
 */
export interface Interceptor {
  install(): () => void
  readonly installed: boolean
}

const DEFAULT_CHANNELS: readonly RequestChannel[] = ['fetch', 'xhr', 'beacon']

/**
 * 创建请求拦截器。
 *
 * 接管 `fetch` / `XMLHttpRequest` / `sendBeacon`（以及显式开启时的表单提交），
 * 按 {@link InterceptionPolicy} 判定，需要确认的请求挂起到用户表态之后再决定
 * 放行或丢弃。
 *
 * 三条实现纪律，写实现时不得妥协：
 *
 * 1. **未命中的请求必须原样透传**，包括 `this` 绑定、参数个数与返回值类型。
 *    宿主代码对 `fetch` 的封装千奇百怪，任何形态上的偏差都会变成难查的怪 bug。
 * 2. **判定失败一律从严**。策略执行本身抛错时按需要确认处理，绝不能因为闸门自己
 *    出错就放行。
 * 3. **拒绝要给出可分辨的失败**，而不是静默丢弃——调用方需要能区分「被用户拒了」
 *    和「网络挂了」，这与核心包用 `cancelled` 标记而非文案判定取消是同一条原则。
 */
export function createInterceptor(options: InterceptorOptions): Interceptor {
  const view = options.view ??
    (typeof window === 'undefined' ? undefined : window as Window & typeof globalThis)
  const channels = new Set(options.channels ?? DEFAULT_CHANNELS)
  let installed = false
  let sequence = 0

  /**
   * 判定一个请求，并在需要时问人。
   *
   * @returns 是否放行。
   */
  const gate = async (request: InterceptedRequest): Promise<boolean> => {
    const evaluated = evaluate(request, options)
    options.onVerdict?.(request, evaluated.verdict)

    if (evaluated.verdict.action === 'allow') return true
    if (evaluated.verdict.action === 'deny') return false

    const disclosure = await describeRequest(request, options.policy, evaluated.ruleId)
    try {
      return await options.confirm({
        request,
        risk: evaluated.verdict.risk,
        ...(disclosure ? { disclosure } : {})
      })
    } catch (_error) {
      // 问不出结果不等于放行——闸门建在一个可以抛错的回调上就没有意义了。
      return false
    }
  }

  const nextId = (): string => `req-${++sequence}`

  return {
    get installed() {
      return installed
    },
    install() {
      // 幂等：叠两层 patch 会让同一个请求被判定两次。
      if (installed || !view) return () => undefined
      installed = true
      let cleaned = false
      const restores: Array<() => void> = []

      try {
        if (channels.has('fetch')) restores.push(patchFetch(view, gate, nextId))
        if (channels.has('xhr')) restores.push(patchXhr(view, gate, nextId))
        if (channels.has('beacon')) {
          restores.push(patchBeacon(view, options, nextId))
        }
        if (channels.has('form')) restores.push(patchForm(view, gate, nextId))
      } catch (error) {
        for (let index = restores.length - 1; index >= 0; index -= 1) {
          try {
            restores[index]()
          } catch (_restoreError) {
            // 回滚失败不能覆盖最初的安装错误。
          }
        }
        installed = false
        throw error
      }

      return () => {
        if (cleaned) return
        cleaned = true
        if (!installed) return
        installed = false
        for (let index = restores.length - 1; index >= 0; index -= 1) {
          restores[index]()
        }
      }
    }
  }
}

interface EvaluatedGate {
  verdict: Verdict
  ruleId?: string
}

/**
 * 跑一次判定策略。
 *
 * 归属判定与策略求值都可能抛错（宿主的遮罩实现、规则里的 `when`）。**一律按需要
 * 确认处理**：闸门自己出错时放行，等于在最需要它的时候把它关掉。
 */
function evaluate(
  request: InterceptedRequest,
  options: InterceptorOptions
): EvaluatedGate {
  let isAgentActive = true
  try {
    isAgentActive = options.attribution.isAgentActive()
  } catch (_error) {
    // 归属未知时按 Agent 发起处理，走完整闸门。
    isAgentActive = true
  }

  let isPreAuthorized = false
  try {
    isPreAuthorized = options.authorization?.isAuthorized() ?? false
  } catch (_error) {
    isPreAuthorized = false
  }

  try {
    const result = evaluateRequest({
      request,
      policy: options.policy,
      isAgentActive,
      isPreAuthorized
    })
    return { verdict: result.verdict, ruleId: result.verdict.ruleId }
  } catch (_error) {
    return { verdict: { action: 'confirm', risk: 'write' } }
  }
}

/** 找到命中的规则并跑它的 `describe`，把原始请求翻译成人话。 */
async function describeRequest(
  request: InterceptedRequest,
  policy: InterceptionPolicy,
  ruleId?: string
): Promise<RequestDisclosure | undefined> {
  if (!ruleId) return undefined
  const rule = findRule(policy, ruleId)
  if (!rule?.describe) return undefined
  try {
    return await rule.describe(request)
  } catch (_error) {
    // 披露失败只降级卡片质量，不该连带把请求拒掉——那会把一个可用的确认流程
    // 变成死路。
    return undefined
  }
}

function findRule(policy: InterceptionPolicy, ruleId: string): RequestRule | undefined {
  return [...(policy.danger ?? []), ...(policy.allow ?? [])]
    .find(rule => rule.id === ruleId)
}

/**
 * 接管 `fetch`。
 *
 * 保留原函数的形态：`this` 绑定、参数原样透传、返回值不做包装。宿主对 `fetch` 的
 * 封装千奇百怪，形态上的任何偏差都会变成难查的怪 bug。
 */
function patchFetch(
  view: Window & typeof globalThis,
  gate: (request: InterceptedRequest) => Promise<boolean>,
  nextId: () => string
): () => void {
  const original = view.fetch
  if (typeof original !== 'function') return () => undefined
  const lifecycle: PatchLifecycle = { active: true }

  const patchedFetch = async function patchedFetch(
    this: unknown,
    ...args: Parameters<typeof fetch>
  ) {
    if (!lifecycle.active) return original.apply(this, args)
    const request = await toInterceptedRequest(view, args, nextId())
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
}

/** `open()` 时记在实例上的方法与 URL，`send()` 时才用得到。 */
interface XhrCallState {
  method?: string
  url?: string
}

/**
 * 接管 `XMLHttpRequest`。
 *
 * `open()` 只记录方法与 URL；真正的判定发生在 `send()`。
 *
 * **已知限制**：`send()` 必须同步返回，而判定是异步的，因此实际发送被推迟到判定
 * 落地之后。依赖「`send` 返回即已发出」的宿主代码会看到时序变化——这是本方案无法
 * 消除的代价。
 */
function patchXhr(
  view: Window & typeof globalThis,
  gate: (request: InterceptedRequest) => Promise<boolean>,
  nextId: () => string
): () => void {
  const XHR = view.XMLHttpRequest
  if (!XHR?.prototype) return () => undefined
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
    callState.set(this, {
      method: method.toUpperCase(),
      url: resolveRequestUrl(view, url)
    })
    return (originalOpen as (...args: unknown[]) => void)
      .apply(this, [method, url, ...rest])
  } as typeof XMLHttpRequest.prototype.open

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
    void gate(request).then(
      allowed => {
        // 等待期间重新 open() 会替换状态对象；旧判定不能影响新的 XHR 配置。
        if (!lifecycle.active || callState.get(this) !== state) return
        if (allowed) {
          originalSend.apply(this, args)
          return
        }
        finishDeniedXhr(view, this)
      },
      () => {
        // 闸门本身异常也必须从严拒绝，并让 Axios 等宿主结束等待。
        if (!lifecycle.active || callState.get(this) !== state) return
        finishDeniedXhr(view, this)
      }
    )
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
}

/**
 * XHR 的 `send()` 没有 Promise 可供拒绝，只能用标准生命周期事件告知宿主。
 *
 * 请求从未交给原生 `send()`，因此调用原生 `abort()` 不会派发事件；这里显式派发
 * `abort` 和 `loadend`，让 Axios 的 `onabort` 拒绝 Promise，并让通用清理逻辑收尾。
 */
function finishDeniedXhr(
  view: Window & typeof globalThis,
  request: XMLHttpRequest
): void {
  request.dispatchEvent(new view.ProgressEvent('abort'))
  request.dispatchEvent(new view.ProgressEvent('loadend'))
}

/**
 * 接管 `navigator.sendBeacon`。
 *
 * beacon 设计上发生在 unload 期，**同步返回 boolean，根本无法挂起**去等一个异步
 * 确认。因此只能二选一：
 *
 * - 放行——等于让一个该确认的写操作直接溜出去；
 * - 拒发并返回 `false`——符合本包立场，但会改变宿主既有行为。
 *
 * 选后者，并通过 {@link InterceptorOptions.onUnholdableRequest} 让接入方知情。
 */
function patchBeacon(
  view: Window & typeof globalThis,
  options: InterceptorOptions,
  nextId: () => string
): () => void {
  const navigatorRef = view.navigator
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
      // beacon 恒为 POST，规范如此。
      method: 'POST',
      url: resolveRequestUrl(view, url),
      headers: {},
      body: parseBody(data),
      channel: 'beacon',
      timestamp: Date.now()
    }
    const evaluated = evaluate(request, options)
    options.onVerdict?.(request, evaluated.verdict)
    if (evaluated.verdict.action === 'allow') {
      return original.apply(this, args)
    }
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
}

/** 从 `fetch` 的参数里提取判定所需的信息。 */
async function toInterceptedRequest(
  view: Window & typeof globalThis,
  args: Parameters<typeof fetch>,
  id: string
): Promise<InterceptedRequest> {
  const [input, init] = args
  const request = isRequestLike(input) ? input : undefined
  const url = resolveRequestUrl(view, request?.url ?? String(input))
  const method = (init?.method ?? request?.method ?? 'GET').toUpperCase()
  const headers = normalizeHeaders(init?.headers ?? request?.headers)
  const body = init?.body !== undefined && init.body !== null
    ? parseBody(init.body)
    : await readRequestBody(request)

  return {
    id,
    method,
    url,
    headers,
    body,
    channel: 'fetch',
    timestamp: Date.now()
  }
}

/**
 * 浏览器网络 API 会基于当前文档解析相对 URL；策略快照必须看到同一个绝对地址。
 *
 * 只规范化纯数据快照，原始参数仍原样传给底层 API，避免改变宿主网络调用的形态。
 */
function resolveRequestUrl(
  view: Window & typeof globalThis,
  value: string | URL
): string {
  return new view.URL(String(value), view.document.baseURI).href
}

/** Request 会跨 iframe / window 流转，不能依赖当前 realm 的构造器。 */
function isRequestLike(input: RequestInfo | URL): input is Request {
  if (typeof input !== 'object' || input === null) return false
  const candidate = input as Partial<Request>
  return typeof candidate.url === 'string' &&
    typeof candidate.method === 'string' &&
    candidate.headers !== undefined &&
    typeof candidate.clone === 'function'
}

/** 只读取 clone，保证真正传给原始 fetch 的 Request 仍可消费。 */
async function readRequestBody(request: Request | undefined): Promise<unknown> {
  if (!request || request.body === null) return undefined
  return parseBody(await request.clone().text())
}

function normalizeHeaders(
  source: HeadersInit | Headers | undefined
): Readonly<Record<string, string>> {
  const collected: Record<string, string> = {}
  if (!source) return collected
  if (Array.isArray(source)) {
    source.forEach(([key, value]) => { collected[String(key).toLowerCase()] = String(value) })
    return collected
  }
  if (typeof (source as Headers).forEach === 'function') {
    const headers = source as Headers
    headers.forEach((value, key) => {
      collected[key.toLowerCase()] = value
    })
    return collected
  }
  Object.entries(source).forEach(([key, value]) => {
    collected[key.toLowerCase()] = String(value)
  })
  return collected
}

/**
 * 尽力把请求体解析成规则好判定的形态。
 *
 * JSON 解析成对象，其余保持原样——解析失败绝不能中断请求，那会把一个格式问题
 * 升级成功能故障。
 */
function parseBody(body: BodyInit | null | undefined): unknown {
  if (body === null || body === undefined) return undefined
  if (typeof body !== 'string') return body
  try {
    return JSON.parse(body)
  } catch (_error) {
    return body
  }
}
