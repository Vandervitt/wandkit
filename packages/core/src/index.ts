/**
 * toolairlock —— in-app LLM Agent 的写操作治理层。
 *
 * 本包不解析 DOM、不调模型、不渲染界面。它提供的是 Agent 与真实写操作之间的那道闸：
 * 风险分级的工具契约、类型层面强制的两阶段写入、确认前的二次校验、权限过滤、
 * 写入不确定态建模，以及结构化审计。
 *
 * 测试期工具在 `toolairlock/testing` 下。
 */

// ── 契约 ──────────────────────────────────────────────────────────
export type {
  ToolDefinition,
  ReadToolDefinition,
  WriteToolDefinition,
  NavigationToolDefinition,
  ToolExecutionContext,
  ToolRisk,
  ExecutionMode,
  ToolLifecycle,
  ToolLifecycleStatus
} from './contracts/tool'
export {
  defineReadTool,
  defineWriteTool,
  defineNavigationTool,
  buildToolFunctionName
} from './contracts/tool'

export type { ModuleDefinition } from './contracts/module'
export type { PageAdapter } from './contracts/pageAdapter'
export type { DeadlineScope, RunDeadlinePhase } from './contracts/deadline'
export type {
  ToolResult,
  PreparedAction,
  ConfirmationRow,
  ConfirmationRawRequest,
  UiEffect
} from './contracts/result'
export {
  cancelledResult,
  isCancelledResult,
  ToolPreparationError,
  ToolPreparationNotice
} from './contracts/result'
export type {
  RunSnapshot,
  RunState,
  RunStatus,
  TaskOutcome,
  TaskTimeout,
  TaskFailure,
  TaskOutcomeError
} from './contracts/run'
export type { LlmMessage, LlmAssistantMessage, LlmClient } from './contracts/llm'
export { toOpenAIToolDefinition } from './contracts/openAITool'
export { isValidToolSunsetDate } from './contracts/toolLifecycle'
export {
  literalUnionFromOptions,
  labelsFromOptions
} from './contracts/literalUnion'
export type { LabeledLiteralOption } from './contracts/literalUnion'

// ── 配置 ──────────────────────────────────────────────────────────
export type { AirlockMessages } from './config/messages'
export { defaultMessages, resolveMessages, formatMessage } from './config/messages'

// ── 运行时 ────────────────────────────────────────────────────────
export { AgentRuntime } from './runtime/agentRuntime'
export type {
  AgentRuntimeDependencies,
  AgentRuntimeOptions,
  RuntimeUiEvent
} from './runtime/agentRuntime'
export { transition } from './runtime/runStateMachine'
export type { RunEvent } from './runtime/runStateMachine'
export {
  composePromptMessages,
  createPromptComposer,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_TIME_ZONE
} from './runtime/promptComposer'
export type { ComposePromptOptions, PromptComposerConfig } from './runtime/promptComposer'
export { TraceCollector, DEFAULT_TRACE_STORAGE_KEY } from './runtime/traceCollector'
export type { RunTrace, TraceStorage } from './runtime/traceCollector'
export {
  installTraceDiagnostics,
  DEFAULT_TRACE_GLOBAL_KEY
} from './runtime/traceDiagnostics'
export type { TraceDiagnosticsTarget } from './runtime/traceDiagnostics'
export { ConversationStore } from './runtime/conversationStore'
export { normalizeLlmAssistantMessage } from './runtime/llmResponseNormalizer'
export { deepClone } from './runtime/deepClone'
export {
  parseToolArguments,
  invalidJsonResult,
  invalidInputResult,
  executionFailureResult
} from './runtime/resultNormalizer'

// ── 发现与预算 ────────────────────────────────────────────────────
export { resolveCandidates } from './discovery/candidateResolver'
export type { ResolveCandidatesOptions } from './discovery/candidateResolver'
export { filterAuthorizedModules, filterAuthorizedTools } from './discovery/permissionFilter'
export {
  applyMessageBudget,
  selectToolsWithinBudget,
  MAX_CANDIDATE_MODULES,
  MAX_EXPOSED_TOOLS,
  MAX_PROMPT_CHARS
} from './discovery/budget'

// ── 执行 ──────────────────────────────────────────────────────────
export { ActionRouter } from './execution/actionRouter'
export type { ActionRouterDependencies, ExecuteActionOptions } from './execution/actionRouter'
export { ConfirmationManager } from './execution/confirmationManager'
export type { ConfirmationRequest, PendingPreparedCall } from './execution/confirmationManager'
export {
  NavigationCoordinator,
  DEFAULT_REQUEST_ID_QUERY_KEY
} from './execution/navigationCoordinator'
export type { RouterPort, RouterLocation } from './execution/navigationCoordinator'
export { PageAdapterRegistry } from './execution/pageAdapterRegistry'
export { createPageBridgeController } from './execution/pageBridgeController'
export type {
  PageBridgeController,
  PageBridgeControllerOptions
} from './execution/pageBridgeController'

// ── 注册表 ────────────────────────────────────────────────────────
export { createToolRegistry } from './registry/toolRegistry'
export type { ToolRegistry } from './registry/toolRegistry'
export { ModuleRegistry } from './registry/moduleRegistry'
export { loadDefaults } from './registry/autoDiscovery'
export type { WebpackContext, DiscoveredDefinitions } from './registry/autoDiscovery'
