export type RunDeadlinePhase =
  | 'page_context'
  | 'prompt_composition'
  | 'model_call'
  | 'write_preparation'
  | 'write_revalidation'
  | 'route_navigation'
  | 'page_adapter_wait'
  | 'read_execution'
  | 'navigation_execution'
  | 'write_execution'
  | 'ui_effect'

export interface DeadlineScope {
  run<T>(
    phase: RunDeadlinePhase,
    operation: () => T | Promise<T>
  ): Promise<T>
  remainingMs(): number
}
