import type { ConfirmationRow, PreparedAction } from '../contracts/result'
import type { ToolRisk } from '../contracts/tool'

/** 已准备好、正等待人工批准的写操作。Runtime 内部结构。 */
export interface PendingPreparedCall {
  /** 界面在批准/拒绝时回传的稳定 ID，形如 `${runId}:${toolCallId}`。 */
  confirmationId: string
  /** 发起本次操作的模型工具调用，用于把结果归属回去。 */
  toolCallId: string
  functionName: string
  /**
   * 模型给出的原始参数。保留它只有一个目的：确认时重跑 `prepare` 并做比对。
   * 永远不会传给 `execute`。
   */
  input: unknown
  /** 用户当时看到的内容。执行前会与重跑结果比对。 */
  prepared: PreparedAction
  /** 收窄到会改数据的两个等级——只有它们会进这个队列。 */
  risk: Extract<ToolRisk, 'write' | 'destructive'>
}

/** 待确认项投影给宿主界面渲染的形状。 */
export interface ConfirmationRequest {
  confirmationId: string
  toolCallId: string
  functionName: string
  title: string
  rows: ConfirmationRow[]
  impact?: string
  risk: PendingPreparedCall['risk']
}

/**
 * 等待批准的写操作 FIFO 队列。
 *
 * 严格逐个确认。当模型在一轮里提出多个写操作时，它们会被逐条确认，而不是打包成
 * 一个「全部批准」——打包正是把确认变成条件反射式点击的原因，而且会让审计记录说不清
 * 人到底审过哪一次具体改动。
 *
 * 注意这里刻意缺失的能力：本类从不**执行**任何东西。它只保存意图并交还出去。执行发生
 * 在 Runtime 里，在重跑并比对 `prepare` 之后。
 */
export class ConfirmationManager {
  private readonly queue: PendingPreparedCall[] = []

  /**
   * 追加已准备好的调用，并返回此刻应当显示在屏幕上的那一项。
   *
   * @returns 队首项；队列为空时返回 `undefined`。
   */
  enqueue(items: PendingPreparedCall[]): ConfirmationRequest | undefined {
    this.queue.push(...items)
    return this.current()
  }

  /** 当前正等待用户处理的请求，已投影为展示用形状。 */
  current(): ConfirmationRequest | undefined {
    const item = this.queue[0]
    if (!item) return undefined
    return {
      confirmationId: item.confirmationId,
      toolCallId: item.toolCallId,
      functionName: item.functionName,
      title: item.prepared.title,
      rows: item.prepared.rows,
      impact: item.prepared.impact,
      risk: item.risk
    }
  }

  /**
   * 批准后出队。
   *
   * 批准**不等于**写入一定会发生：Runtime 仍会重跑 `prepare`，内容变了就拒绝执行。
   *
   * @throws `confirmationId` 不是队首时抛出。
   */
  approve(confirmationId: string): PendingPreparedCall {
    return this.takeCurrent(confirmationId)
  }

  /**
   * 拒绝后出队。Runtime 会把这次拒绝回报给模型，让它停止继续推进该操作。
   *
   * @throws `confirmationId` 不是队首时抛出。
   */
  reject(confirmationId: string): PendingPreparedCall {
    return this.takeCurrent(confirmationId)
  }

  /** 处理完一项后的下一项（当本轮提出了多个写操作时）。 */
  advance(): ConfirmationRequest | undefined {
    return this.current()
  }

  /** 丢弃全部待确认项。Run 结束或被停止时调用。 */
  clear(): void {
    this.queue.splice(0)
  }

  /**
   * 取出队首，但仅当调用方点名的就是它。
   *
   * 这道 ID 校验让过期界面变得无害：上一个 Run 遗留在屏幕上的确认框回传的是一个
   * 已不在队首的 ID，此时抛错远好过批准了此刻恰好排在队列里的那个写操作。
   */
  private takeCurrent(confirmationId: string): PendingPreparedCall {
    const item = this.queue[0]
    if (!item || item.confirmationId !== confirmationId) {
      throw new Error('Confirmation not found or no longer current')
    }
    return this.queue.shift() as PendingPreparedCall
  }
}
