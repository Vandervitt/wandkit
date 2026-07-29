import type { InterceptedRequest, Verdict } from './types'

/**
 * 把拦截判定写入核心的审计轨迹。
 *
 * 治理有三件事：拦住、问人、**留痕**。前两件由拦截器与确认卡片完成，这一件补齐
 * 闭环——事后要能回答「这次写入是谁发起的、走的哪条规则、人批了没有」。
 *
 * 与其余模块一样，本文件**不 import 核心包**：用最小的鸭子类型描述 `TraceCollector`，
 * 因此拦截器在没有 Agent 运行时的页面上依然可以单独使用。
 */

/** 轨迹收集器的最小形状。与核心的 `TraceCollector` 结构兼容。 */
export interface TraceCollectorLike {
  record(runId: string, event: {
    type: string
    names?: string[]
    functionName?: string
    effectType?: string
  }): void
}

export interface TraceRecorderOptions {
  traces: TraceCollectorLike
  /**
   * 当前活跃 Run 的 ID。
   *
   * 返回 `undefined` 表示此刻没有 Run 可归属——拦截器可以在纯宿主页面上单独使用，
   * 那时本就没有 Agent 运行时。此时跳过记录，而不是报错。
   */
  getRunId(): string | undefined
}

/** 判定动作到轨迹事件类型的映射。 */
const EVENT_TYPES: Record<Verdict['action'], string> = {
  allow: 'request_allowed',
  confirm: 'request_confirm_required',
  deny: 'request_denied'
}

/**
 * 创建一个可直接用作 `onVerdict` 的记录器。
 *
 * **放行也记录**：审计需要能证明「这次没拦」是有依据的——只记拦下的，等于把闸门
 * 最常走的那条路径变成盲区。
 */
export function createTraceRecorder(
  options: TraceRecorderOptions
): (request: InterceptedRequest, verdict: Verdict) => void {
  return (request, verdict) => {
    const runId = options.getRunId()
    if (!runId) return

    try {
      options.traces.record(runId, {
        type: EVENT_TYPES[verdict.action],
        functionName: `${request.method} ${safePath(request.url)}`,
        ...(verdict.ruleId ? { names: [verdict.ruleId] } : {}),
        ...(verdict.action === 'confirm' ? { effectType: verdict.risk } : {})
      })
    } catch (_error) {
      // 记不了日志不该把功能弄挂——与核心 TraceCollector 在存储不可用时静默降级
      // 是同一条取舍。
    }
  }
}

/**
 * 取 URL 的路径部分，剥掉 origin 与 query。
 *
 * **query 必须剥掉**：它常带 token、手机号一类的东西，而轨迹会落到本地存储。核心的
 * `TraceCollector` 连用户原话都只存长度（`[redacted:length=N]`），判定轨迹没有理由
 * 反而更宽松。
 *
 * origin 一并去掉是因为它对审计无用且更长——同源信息不构成任何鉴别力。
 *
 * 请求体则完全不进轨迹：那是最容易带敏感数据的部分，而它对「发生过什么操作」这个
 * 审计问题并非必需。
 */
function safePath(url: string): string {
  try {
    return new URL(url).pathname
  } catch (_error) {
    // 相对 URL 或畸形 URL：退回到去掉 query / hash 的原串。
    return url.split(/[?#]/)[0]
  }
}
