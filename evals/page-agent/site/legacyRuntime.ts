import {
  ActionRouter,
  AgentRuntime,
  NavigationCoordinator,
  PageAdapterRegistry,
  TraceCollector,
  createPromptComposer,
  createToolRegistry,
  resolveCandidates,
  type LlmAssistantMessage,
  type LlmClient,
  type ModuleDefinition,
  type RunStatus,
  type RuntimeUiEvent,
  type TraceStorage
} from '../../../packages/core/src/index'
import {
  PAGE_AGENT_SYSTEM_PROMPT,
  PageController,
  createPageTools,
  stopRequestTracking
} from '../../../packages/executor/src/index'
import { ScriptedLlm } from './scriptedLlm'

export interface LegacyRuntimeResult {
  readonly status: 'completed' | 'failed' | 'cancelled' | 'awaiting_confirmation'
  readonly answer: string
  /**
   * 模型发出的页面工具调用数，也就是动作尝试数。
   *
   * 非法 JSON / Schema、未知工具及参数纠正调用同样计入，避免协议错误更多的 Runner
   * 在步骤分位数上虚假更优。这不是成功执行 DOM 动作的次数，也不是模型轮数。
   */
  readonly steps: number
  readonly stopReason?: string
}

export interface LegacyRuntimeOptions {
  readonly task: string
  readonly llm?: LlmClient
  readonly replies?: readonly LlmAssistantMessage[]
}

const PAGE_ROUTE = '*'
let pageRunnerActive = false

const pageModule: ModuleDefinition = {
  id: 'page',
  title: '页面操作',
  description: '读取并操作当前页面上的任意元素',
  aliases: ['页面'],
  routes: [PAGE_ROUTE],
  permissions: [],
  prompt: '通过读取页面、点击、输入和选择完成用户请求。',
  examples: [],
  formatContext: () => ''
}

function resolveLlm(options: LegacyRuntimeOptions): LlmClient {
  if ((options.llm === undefined) === (options.replies === undefined)) {
    throw new Error('llm 与 replies 必须且只能提供一个')
  }
  return options.llm ?? new ScriptedLlm(options.replies ?? [])
}

function isResultStatus(status: RunStatus): status is LegacyRuntimeResult['status'] {
  return status === 'completed' || status === 'failed' || status === 'cancelled' ||
    status === 'awaiting_confirmation'
}

function createIsolatedTraces(): TraceCollector {
  let serialized: string | null = null
  const storage: TraceStorage = {
    getItem: () => serialized,
    setItem: (_key, value) => {
      serialized = value
    }
  }
  return new TraceCollector(1, storage)
}

function countPageActionAttempts(traces: TraceCollector): number {
  return traces.recent().reduce((total, trace) => total + trace.events.reduce(
    (traceTotal, event) => traceTotal + (
      event.type === 'model_response' ? (event.names?.length ?? 0) : 0
    ),
    0
  ), 0)
}

export async function runLegacyRuntime(
  options: LegacyRuntimeOptions
): Promise<LegacyRuntimeResult> {
  if (pageRunnerActive) {
    throw new Error('同一页面不能并发运行多个旧 Runtime Runner')
  }
  pageRunnerActive = true

  let controller: PageController | undefined

  try {
    const llm = resolveLlm(options)
    controller = new PageController()
    const registry = createToolRegistry(
      [pageModule],
      createPageTools({ moduleId: pageModule.id, owner: 'page-agent-eval', controller })
    )
    const adapters = new PageAdapterRegistry()
    const traces = createIsolatedTraces()
    let answer = ''
    let stopReason: string | undefined

    const emit = (event: RuntimeUiEvent): void => {
      if (event.type === 'assistant' && typeof event.content === 'string') {
        answer = event.content
      }
      if (event.type === 'state' && event.stopReason !== undefined) {
        stopReason = event.stopReason
      }
    }

    const runtime = new AgentRuntime({
      llm,
      registry,
      resolveCandidates,
      composePrompt: createPromptComposer({
        systemPrompt: PAGE_AGENT_SYSTEM_PROMPT,
        timeZone: 'Asia/Shanghai'
      }),
      actionRouter: new ActionRouter({
        adapters,
        navigation: new NavigationCoordinator(
          {
            getCurrentRouteName: () => PAGE_ROUTE,
            push: async () => undefined
          },
          adapters
        ),
        resolveRouteName: () => PAGE_ROUTE
      }),
      getRouteName: () => PAGE_ROUTE,
      getPermissions: () => [],
      getPageContext: () => null,
      emit
    }, { traces })

    const snapshot = await runtime.start(options.task)
    if (!isResultStatus(snapshot.status)) {
      throw new Error(`旧 Runtime 返回了非预期状态: ${snapshot.status}`)
    }
    return {
      status: snapshot.status,
      answer,
      steps: countPageActionAttempts(traces),
      ...(stopReason === undefined ? {} : { stopReason })
    }
  } finally {
    controller?.dispose()
    if (controller) stopRequestTracking()
    pageRunnerActive = false
  }
}
