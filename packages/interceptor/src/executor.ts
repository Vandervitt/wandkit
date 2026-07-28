import type { ToolDefinition } from 'toolairlock'

/**
 * 自由执行器：让 Agent 做**没有被声明成工具**的事。
 *
 * 这是「能力去声明化」的落点。声明式工具的能力上限等于你写了多少个工具；接上
 * 执行器后，Agent 能做的事等于用户在界面上能做的事。
 *
 * 刻意做成窄端口而不是绑定某个实现（与 `RouterPort` / `LlmClient` 同一风格）：
 * page-agent 只是其中一种实现，宿主也可以自建，或接一个按 OpenAPI 自由调用的
 * 后端执行器。
 */
export interface ExecutorPort {
  /**
   * 执行一段自然语言指令。
   *
   * @param signal 用户停止或 Run 超时时被 abort。实现**必须**透传给底层，否则
   *   停止之后 Agent 还在页面上继续点。
   */
  execute(instruction: string, signal?: AbortSignal): Promise<ExecutorResult>
}

export interface ExecutorResult {
  ok: boolean
  message: string
  /** 执行器实际做了哪些步骤，用于回喂模型与写入 trace。 */
  steps?: string[]
}

/**
 * 把执行器包装成一个内置工具。
 *
 * **为什么走工具形态而不是新开一条并行通道**：轮次上限、工具预算、权限过滤、
 * trace、`maxToolCalls` 这些运行时既有的约束会自动全部适用，不必再实现一套平行的
 * 生命周期管理。
 *
 * **它为什么不能有 `prepare`**：调用之前无从知道它会点什么，因此风险等级也无法
 * 预先判定。风险分类被推迟到了「请求真正发出的那一刻」，由拦截器逐个把关——这正是
 * 本设计能同时拿到广度与安全的原因。
 *
 * **权限**：该工具必须能被权限过滤掉。没有对应权限的用户，模型根本看不到它，
 * 最小权限原则在这一层依然成立。
 *
 * @see docs/feat_20260728_请求拦截治理/design.md §4
 */
export interface ExecutorToolOptions {
  moduleId: string
  name: string
  version: number
  owner: string
  /**
   * 发给模型的描述。
   *
   * 必须写清「**什么时候**该用它」——尤其要写明它是兜底手段：有更精确的声明式
   * 工具时应当优先用那个，因为那条路径的确认发生在动作之前，且卡片能展示业务
   * 语义而不是原始请求。
   */
  description: string
  /** 暴露该工具所需的权限。强烈建议非空。 */
  permissions?: string[]
  executor: ExecutorPort
}

/**
 * 阻塞于核心包移除 `ToolRisk`，见 design.md §4.4。
 *
 * 执行器工具在现有风险枚举里**无处安放**：四档都要求风险在注册时已知，而它的风险
 * 要到请求发出那一刻才判定。但正确的解法不是加一档，而是认识到 `risk` 这个自声明
 * 字段本身就该被名单取代——它无法验证，一个偷偷写库的 `read` 工具是静默绕过闸门的。
 *
 * 改造后本函数产出的工具不带 `risk`：它只是一个没有 `prepare` 的一阶段工具，
 * 其副作用由拦截器按真实请求逐个定级。
 */
export function defineExecutorTool(_options: ExecutorToolOptions): ToolDefinition {
  throw new Error('Not implemented: 阻塞于核心包移除 ToolRisk，见 design.md §4.4')
}
