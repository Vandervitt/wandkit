import {
  ActionRouter,
  AgentRuntime,
  NavigationCoordinator,
  PageAdapterRegistry,
  createPromptComposer,
  createToolRegistry,
  resolveCandidates,
  type LlmAssistantMessage,
  type LlmClient,
  type ModuleDefinition,
  type RunStatus,
  type RuntimeUiEvent
} from '../../../packages/core/src/index'
import {
  PAGE_AGENT_SYSTEM_PROMPT,
  PageController,
  createPageTools
} from '../../../packages/executor/src/index'
import { ScriptedLlm } from './scriptedLlm'

export interface LegacyRuntimeResult {
  readonly status: 'completed' | 'failed' | 'cancelled' | 'awaiting_confirmation'
  readonly answer: string
  readonly steps: number
  readonly stopReason?: string
}

export interface LegacyRuntimeOptions {
  readonly task: string
  readonly llm?: LlmClient
  readonly replies?: readonly LlmAssistantMessage[]
}

const PAGE_ROUTE = '*'

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

export async function runLegacyRuntime(
  options: LegacyRuntimeOptions
): Promise<LegacyRuntimeResult> {
  const llm = resolveLlm(options)
  const controller = new PageController()
  const registry = createToolRegistry(
    [pageModule],
    createPageTools({ moduleId: pageModule.id, owner: 'page-agent-eval', controller })
  )
  const adapters = new PageAdapterRegistry()
  let answer = ''
  let steps = 0
  let stopReason: string | undefined

  const emit = (event: RuntimeUiEvent): void => {
    if (event.type === 'assistant' && typeof event.content === 'string') {
      answer = event.content
    }
    if (event.type === 'state' && event.snapshot?.status === 'executing_read') {
      steps += 1
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
  })

  try {
    const snapshot = await runtime.start(options.task)
    if (!isResultStatus(snapshot.status)) {
      throw new Error(`旧 Runtime 返回了非预期状态: ${snapshot.status}`)
    }
    return {
      status: snapshot.status,
      answer,
      steps,
      ...(stopReason === undefined ? {} : { stopReason })
    }
  } finally {
    controller.dispose()
  }
}
