import type { ValidateFunction } from 'ajv'
import type { ModuleDefinition } from '../contracts/module'
import {
  toOpenAIToolDefinition,
  type OpenAIToolDefinition
} from '../contracts/openAITool'
import {
  buildToolFunctionName,
  type ToolDefinition,
  type ExecutionMode,
  type ToolRisk
} from '../contracts/tool'
import { isValidToolSunsetDate } from '../contracts/toolLifecycle'
import { assertValidInput, compileSchema } from './contractValidator'
import { ModuleRegistry } from './moduleRegistry'

/** 工具本体，加上注册时一次性推导出来的东西。 */
interface RegisteredTool {
  definition: ToolDefinition
  /** 暴露给模型的稳定名，同时也是注册表的键。 */
  functionName: string
  /** 提前编译好的 Ajv 校验器，让每次调用的校验成本足够低。 */
  validate: ValidateFunction
}

const validRisks: ToolRisk[] = ['read', 'write', 'destructive', 'navigation']
const validExecutionModes: ExecutionMode[] = ['global', 'page', 'hybrid']

export type { OpenAIToolDefinition } from '../contracts/openAITool'

/**
 * 在运行时重新校验类型系统在编译期已经保证的东西。
 *
 * 工具常常经由构建工具 glob 和无类型边界进来（`loadDefaults` 返回的是包里恰好有的
 * 任何东西），因此一个 JS 侧的接入方或一次错误的 cast，就能把没有 `prepare` 的
 * 「写工具」偷渡进来。那会直接绕过确认闸门——本包存在的意义就是防这一件事——所以
 * 这份冗余校验值得在启动时付一次，并且让它响亮地失败。
 */
function assertExecutionContract(tool: ToolDefinition, functionName: string): void {
  if (!validRisks.includes(tool.risk)) {
    throw new Error('Invalid tool risk level: ' + functionName)
  }
  if (!validExecutionModes.includes(tool.executionMode)) {
    throw new Error('Invalid tool execution mode: ' + functionName)
  }

  if (tool.risk === 'write' || tool.risk === 'destructive') {
    if (typeof tool.prepare !== 'function' || typeof tool.execute !== 'function') {
      throw new Error('Write tools must implement both prepare and execute: ' + functionName)
    }
    return
  }

  if (typeof tool.execute !== 'function') {
    throw new Error('Tool must implement execute: ' + functionName)
  }
  if (tool.risk === 'navigation' && tool.executionMode !== 'page') {
    throw new Error('Navigation tools must use the page execution mode: ' + functionName)
  }
}

/**
 * 经过校验的工具存储，以稳定函数名为键。
 *
 * 构造过程快速失败：任何契约违规都会在应用启动前抛出，而不是等到生产环境里表现为
 * 一次错投的工具调用。所有读取访问器都会隐藏已废弃的工具，因此改一个字段就能让
 * 废弃在所有地方同时生效。
 */
export class ToolRegistry {
  private readonly toolsByFunctionName = new Map<string, RegisteredTool>()

  /**
   * @throws 任一工具违反契约、函数名重复、引用了不存在的模块，或声明了不可用的
   *   替代工具时抛出。
   */
  constructor(
    public readonly modules: ModuleRegistry,
    tools: ToolDefinition[]
  ) {
    tools.forEach((tool) => this.register(tool))
    // 等所有工具都进 map 之后再校验：替代工具可能先于指向它的那个工具被声明。
    this.assertLifecycleRelationships()
  }

  private register(tool: ToolDefinition): void {
    const functionName = buildToolFunctionName(tool.moduleId, tool.name, tool.version)
    if (!this.modules.has(tool.moduleId)) {
      throw new Error('Tool references an unregistered module: ' + tool.moduleId)
    }
    if (this.toolsByFunctionName.has(functionName)) {
      // 同一个名字对应两个工具，会让模型的选择产生歧义，也会让审计记录无法解读。
      throw new Error('Duplicate tool function name: ' + functionName)
    }
    if (!tool.owner || !tool.owner.trim()) {
      throw new Error('Tool owner must not be empty: ' + functionName)
    }
    if (!tool.lifecycle || !['active', 'deprecated'].includes(tool.lifecycle.status)) {
      throw new Error('Invalid tool lifecycle: ' + functionName)
    }
    if (tool.lifecycle.sunsetAt && !isValidToolSunsetDate(tool.lifecycle.sunsetAt)) {
      throw new Error('Invalid tool sunset date: ' + functionName)
    }

    assertExecutionContract(tool, functionName)

    let validate: ValidateFunction
    try {
      validate = compileSchema(tool.schema)
    } catch (_error) {
      // Ajv 的编译错误只会报出内部关键字，在这里帮不上忙；作者真正需要的是函数名，
      // 好定位到坏掉的那个 Schema。
      throw new Error('Invalid schema: ' + functionName)
    }

    this.toolsByFunctionName.set(functionName, { definition: tool, functionName, validate })
  }

  /** 该名字是否对应一个**未废弃**的工具。 */
  has(functionName: string): boolean {
    return this.isActive(this.toolsByFunctionName.get(functionName))
  }

  /** 该名字对应的未废弃工具；未知或已废弃时返回 `undefined`。 */
  get(functionName: string): ToolDefinition | undefined {
    const registered = this.toolsByFunctionName.get(functionName)
    return this.isActive(registered) ? registered.definition : undefined
  }

  /** 全部未废弃工具，按函数名排序以保证输出确定。 */
  getAll(): ToolDefinition[] {
    return this.activeTools().map(({ definition }) => definition)
  }

  /** 某个模块下的未废弃工具，按函数名排序。 */
  getByModule(moduleId: string): ToolDefinition[] {
    return this.activeTools()
      .filter(({ definition }) => definition.moduleId === moduleId)
      .map(({ definition }) => definition)
  }

  /**
   * 用工具的 Schema 校验模型给出的参数。
   *
   * 查找时把已废弃的条目也算进来：会话里可能还引用着它，而告诉模型「改用 X」远比
   * 告诉它「未知工具」有用。
   *
   * @throws 名字未知、工具已废弃，或校验不通过时抛出。
   */
  validateInput(functionName: string, input: unknown): void {
    const registered = this.toolsByFunctionName.get(functionName)
    if (!registered) {
      throw new Error('Unknown tool function name: ' + functionName)
    }
    if (registered.definition.lifecycle?.status === 'deprecated') {
      throw new Error(
        'Tool is deprecated, use ' + registered.definition.lifecycle.replacement
      )
    }
    assertValidInput(registered.validate, input)
  }

  /** 全部未废弃工具，转成 OpenAI 工具调用形态，可直接发给模型。 */
  toOpenAITools(): OpenAIToolDefinition[] {
    return this.activeTools().map(({ definition }) => toOpenAIToolDefinition(definition))
  }

  /**
   * 每个已废弃工具都必须指向一个存在且本身未废弃的替代工具。
   *
   * 没有这条校验，废弃链（v1 → v2 → v3，其中 v2 也已废弃）会给模型留下一个死胡同：
   * 它拿到的唯一指引，指向的是另一个同样调不了的工具。
   */
  private assertLifecycleRelationships(): void {
    this.sortedTools().forEach(registered => {
      const lifecycle = registered.definition.lifecycle
      if (!lifecycle) return
      if (lifecycle.status !== 'deprecated') return
      const replacement = lifecycle.replacement
        ? this.toolsByFunctionName.get(lifecycle.replacement)
        : undefined
      if (!replacement || replacement.definition.lifecycle?.status !== 'active') {
        throw new Error(
          'Deprecated tool has no usable replacement: ' + registered.functionName
        )
      }
    })
  }

  private activeTools(): RegisteredTool[] {
    return this.sortedTools().filter(registered => this.isActive(registered))
  }

  private isActive(registered?: RegisteredTool): registered is RegisteredTool {
    return registered?.definition.lifecycle?.status === 'active'
  }

  /**
   * 按函数名排序，使发给模型的工具顺序在多次运行间保持稳定。顺序不稳既会扰动模型
   * 行为，也会让 Prompt 缓存失效。
   */
  private sortedTools(): RegisteredTool[] {
    return Array.from(this.toolsByFunctionName.values())
      .sort((left, right) => left.functionName.localeCompare(right.functionName))
  }
}

/**
 * 一次性构建模块注册表与工具注册表。
 *
 * @throws 任一模块或工具违反契约时抛出。设计为在应用启动时调用，让坏掉的契约
 *   根本发布不出去。
 */
export function createToolRegistry(
  modules: ModuleDefinition[],
  tools: ToolDefinition[]
): ToolRegistry {
  return new ToolRegistry(new ModuleRegistry(modules), tools)
}
