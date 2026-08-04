import type { DeadlineScope, RunDeadlinePhase } from '../contracts/deadline'

export interface DeadlineExceededDetails {
  phase: RunDeadlinePhase
  budgetMs: number
  activeElapsedMs: number
}

export interface RunDeadlineOptions {
  budgetMs: number
  startedAt: number
  now: () => number
  controller: AbortController
  onTimeout(details: DeadlineExceededDetails): boolean
  onPhaseStart?(phase: RunDeadlinePhase): void
}

export class RunDeadlineExceededError extends Error {
  readonly code = 'RUN_DEADLINE_EXCEEDED'

  constructor(readonly details: DeadlineExceededDetails) {
    super(`Run deadline exceeded during ${details.phase}`)
    this.name = 'RunDeadlineExceededError'
  }
}

export class RunDeadline implements DeadlineScope {
  private pausedAt?: number
  private pausedMs = 0

  constructor(private readonly options: RunDeadlineOptions) {}

  pause(): void {
    if (this.pausedAt === undefined) {
      this.pausedAt = this.options.now()
    }
  }

  resume(): void {
    if (this.pausedAt === undefined) return
    this.pausedMs += Math.max(0, this.options.now() - this.pausedAt)
    this.pausedAt = undefined
  }

  activeElapsedMs(): number {
    const currentPauseMs = this.pausedAt === undefined
      ? 0
      : Math.max(0, this.options.now() - this.pausedAt)
    return Math.max(
      0,
      this.options.now() - this.options.startedAt - this.pausedMs - currentPauseMs
    )
  }

  remainingMs(): number {
    if (this.options.budgetMs === Infinity) return Infinity
    return Math.max(0, this.options.budgetMs - this.activeElapsedMs())
  }

  async run<T>(
    phase: RunDeadlinePhase,
    operation: () => T | Promise<T>
  ): Promise<T> {
    const { controller } = this.options
    this.throwIfAborted(controller.signal)

    const remainingMs = this.remainingMs()
    if (remainingMs <= 0) {
      throw this.createTimeout(phase)
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined
    let removeAbortListener = () => undefined
    const abortPromise = new Promise<never>((_resolve, reject) => {
      const onAbort = () => reject(this.abortReason(controller.signal))
      controller.signal.addEventListener('abort', onAbort, { once: true })
      removeAbortListener = () => {
        controller.signal.removeEventListener('abort', onAbort)
      }
      if (controller.signal.aborted) onAbort()
    })
    const operationPromise = Promise.resolve().then(() => {
      this.throwIfAborted(controller.signal)
      this.options.onPhaseStart?.(phase)
      return operation()
    })
    const competitors: Promise<T>[] = [operationPromise, abortPromise]

    if (remainingMs !== Infinity) {
      competitors.push(new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          reject(this.createTimeout(phase))
        }, remainingMs)
      }))
    }

    try {
      return await Promise.race(competitors)
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId)
      removeAbortListener()
    }
  }

  private createTimeout(phase: RunDeadlinePhase): RunDeadlineExceededError {
    const error = new RunDeadlineExceededError({
      phase,
      budgetMs: this.options.budgetMs,
      activeElapsedMs: this.activeElapsedMs()
    })
    if (this.options.onTimeout(error.details)) {
      this.options.controller.abort(error)
    }
    return error
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw this.abortReason(signal)
  }

  private abortReason(signal: AbortSignal): unknown {
    if (signal.reason !== undefined) return signal.reason
    return Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError'
    })
  }
}

export function isRunDeadlineExceededError(
  error: unknown
): error is RunDeadlineExceededError {
  return error instanceof RunDeadlineExceededError
}
