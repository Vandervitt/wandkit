import {
  ActionRouter,
  AgentRuntime,
  NavigationCoordinator,
  PageAdapterRegistry,
  createPromptComposer,
  createToolRegistry,
  cancelledResult,
  type AgentRuntimeOptions,
  type LlmClient,
  type ModuleDefinition,
  type RuntimeUiEvent,
  type ToolDefinition
} from 'wandkit'
import { ChatSession } from '@wandkit/chat'
import {
  connectRuntime,
  type ChatControls,
  type RuntimeUiEventLike
} from '@wandkit/chat/bridge'
import {
  CHAT_DOCK_TAG,
  CHAT_PANEL_TAG,
  WandkitChatDock,
  WandkitChatPanel
} from '@wandkit/chat/ui'
import {
  PAGE_AGENT_SYSTEM_PROMPT,
  PageController,
  createPageTools,
  startRequestTracking,
  type PageControllerOptions
} from '@wandkit/executor'
import {
  createInterceptor,
  createMaskAttribution,
  type InterceptionPolicy,
  type RequestMatcher
} from '@wandkit/interceptor'
import { createConfirmCardHandler } from '@wandkit/interceptor/confirm-ui'
import { InteractionMask } from '@wandkit/ui'

const PAGE_MODULE_ID = 'page'

export interface MountWandkitOptions {
  llm: LlmClient
  heading?: string
  getPermissions?: () => string[]
  container?: HTMLElement
  page?: PageControllerOptions
  runtime?: AgentRuntimeOptions
  interception: {
    policy: InterceptionPolicy
    /** 精确匹配 LLM transport 请求，避免它在 Agent 归属宽限期内被当成业务写请求。 */
    llmRequest?: RequestMatcher
  }
}

export interface MountedWandkit {
  runtime: AgentRuntime
  session: ChatSession
  controls: ChatControls
  destroy(): void
}

export function mountWandkit(options: MountWandkitOptions): MountedWandkit {
  const container = options.container ?? document.body
  const dock = document.createElement(CHAT_DOCK_TAG) as WandkitChatDock
  const panel = document.createElement(CHAT_PANEL_TAG) as WandkitChatPanel
  panel.heading = options.heading ?? 'Wandkit'
  const userExclude = options.page?.exclude
  const controller = new PageController({
    ...options.page,
    exclude: element => isWandkitUi(element, dock) || userExclude?.(element) === true
  })
  const setupCleanups: Array<() => void> = [
    () => dock.remove(),
    () => controller.dispose()
  ]

  try {
    const mask = new InteractionMask({ transparent: true })
    setupCleanups.push(() => mask.disarm())
    const action = { active: false, denied: false }
    const pageModule: ModuleDefinition = {
      id: PAGE_MODULE_ID,
      title: '页面操作',
      description: '读取并操作当前页面上的任意元素',
      aliases: ['页面'],
      routes: ['*'],
      permissions: [],
      prompt: '通过读取页面、点击、输入、选择和滚动完成用户请求。',
      examples: [],
      formatContext: () => ''
    }
    const pageTools = governPageActions(createPageTools({
      moduleId: PAGE_MODULE_ID,
      owner: '@wandkit/browser',
      controller
    }), mask, action)
    const registry = createToolRegistry([pageModule], pageTools)
    const adapters = new PageAdapterRegistry()
    const routeName = (): string => '*'
    const actionRouter = new ActionRouter({
      adapters,
      navigation: new NavigationCoordinator({
        getCurrentRouteName: routeName,
        push: async () => undefined
      }, adapters),
      resolveRouteName: routeName
    })

    const session = new ChatSession()
    const handlers = new Set<(event: RuntimeUiEventLike) => void>()

    const runtime = new AgentRuntime({
      llm: options.llm,
      registry,
      resolveCandidates: () => [PAGE_MODULE_ID],
      composePrompt: createPromptComposer({ systemPrompt: PAGE_AGENT_SYSTEM_PROMPT }),
      actionRouter,
      getRouteName: routeName,
      getPermissions: options.getPermissions ?? (() => []),
      getPageContext: () => null,
      emit(event: RuntimeUiEvent) {
        handlers.forEach(handler => handler(event as RuntimeUiEventLike))
      }
    }, options.runtime)

    const controls = connectRuntime(session, runtime, {
      onEvent(handler) {
        handlers.add(handler)
      }
    })
    setupCleanups.push(() => controls.dispose())

    const confirmationController = new AbortController()
    setupCleanups.push(() => confirmationController.abort())
    const confirmWithCard = createConfirmCardHandler({
      host: panel.confirmationHost,
      signal: confirmationController.signal
    })
    const interceptor = createInterceptor({
      policy: withLlmRequestRule(
        options.interception.policy,
        options.interception.llmRequest
      ),
      attribution: createMaskAttribution({ isMaskArmed: () => mask.armed }),
      async confirm(input) {
        dock.open = true
        session.setStatus('awaiting_confirmation')
        try {
          const approved = await confirmWithCard(input)
          if (!approved && action.active) action.denied = true
          return approved
        } finally {
          if (session.state.status === 'awaiting_confirmation') session.setStatus('busy')
        }
      },
      onVerdict(_request, verdict) {
        if (verdict.action === 'deny' && action.active) action.denied = true
      }
    })
    const uninstallInterceptor = interceptor.install()
    setupCleanups.push(uninstallInterceptor)
    // tracker 必须后装，才能位于 interceptor 外层并覆盖确认等待的完整生命周期。
    const releaseRequestTracking = startRequestTracking()
    setupCleanups.push(releaseRequestTracking)

    panel.addEventListener('send', event => {
      const detail = (event as CustomEvent<{ text?: string }>).detail
      if (detail?.text) void controls.send(detail.text)
    })
    panel.addEventListener('stop', () => controls.stop())
    panel.addEventListener('new-chat', () => runtime.clear())
    dock.appendChild(panel)
    container.appendChild(dock)

    const render = (): void => {
      const state = session.state
      panel.state = state
      dock.state = state
    }
    const unsubscribe = session.subscribe(render)
    setupCleanups.push(unsubscribe)
    render()

    let destroyed = false
    return {
      runtime,
      session,
      controls,
      destroy() {
        if (destroyed) return
        destroyed = true
        runtime.stop()
        confirmationController.abort()
        controls.dispose()
        unsubscribe()
        controller.dispose()
        mask.disarm()
        releaseRequestTracking()
        uninstallInterceptor()
        dock.remove()
      }
    }
  } catch (error) {
    for (let index = setupCleanups.length - 1; index >= 0; index -= 1) {
      try {
        setupCleanups[index]()
      } catch (_cleanupError) {
        // 初始化错误优先；清理失败不能覆盖真正的挂载失败原因。
      }
    }
    throw error
  }
}

function withLlmRequestRule(
  policy: InterceptionPolicy,
  llmRequest?: RequestMatcher
): InterceptionPolicy {
  if (!llmRequest) return policy
  return {
    ...policy,
    allow: [{ id: '@wandkit/browser:llm', match: llmRequest }, ...(policy.allow ?? [])]
  }
}

function governPageActions(
  tools: ToolDefinition[],
  mask: InteractionMask,
  action: { active: boolean, denied: boolean }
): ToolDefinition[] {
  return tools.map(tool => {
    if (tool.risk !== 'read' || tool.name === 'read') return tool
    const execute = tool.execute
    return {
      ...tool,
      async execute(context, input) {
        action.active = true
        action.denied = false
        mask.setLabel(`正在执行：${tool.title}`)
        mask.arm()
        try {
          const result = await execute(context, input)
          return action.denied ? cancelledResult('操作已取消。') : result
        } finally {
          action.active = false
          mask.disarm()
        }
      }
    }
  })
}

function isWandkitUi(element: Element, dock: WandkitChatDock): boolean {
  let current: Element | null = element
  while (current) {
    if (current === dock || current.localName === 'wandkit-mask') return true
    if (current.assignedSlot) {
      current = current.assignedSlot
      continue
    }
    if (current.parentElement) {
      current = current.parentElement
      continue
    }
    const root = current.getRootNode()
    current = 'host' in root ? (root as ShadowRoot).host : null
  }
  return false
}
