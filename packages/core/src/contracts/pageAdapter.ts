import type { UiEffect } from './result'

export interface PageAdapter<TContext = unknown> {
  moduleId: string
  routeName: string
  getContext(signal?: AbortSignal): TContext | Promise<TContext>
  applyUiEffect(
    effect: UiEffect,
    requestId: string,
    signal?: AbortSignal
  ): void | Promise<void>
  refresh?(requestId: string): void | Promise<void>
  locate?(target: unknown, requestId: string): void | Promise<void>
  prefill?(payload: unknown, requestId: string): void | Promise<void>
}
