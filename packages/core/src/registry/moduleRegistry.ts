import type { ModuleDefinition } from '../contracts/module'

/**
 * 按 ID 索引的不可变模块存储。
 *
 * 启动时构建一次，由工具注册表、候选解析和 Runtime 共享。
 */
export class ModuleRegistry {
  private readonly modulesById = new Map<string, ModuleDefinition>()

  /** @throws 两个模块声明了相同 ID 时抛出。 */
  constructor(modules: ModuleDefinition[]) {
    modules.forEach((module) => {
      if (this.modulesById.has(module.id)) {
        // 模块 ID 会被编进工具函数名，重名会让两个不同模块在模型眼里无法区分。
        throw new Error('Duplicate module id: ' + module.id)
      }
      this.modulesById.set(module.id, module)
    })
  }

  has(moduleId: string): boolean {
    return this.modulesById.has(moduleId)
  }

  get(moduleId: string): ModuleDefinition | undefined {
    return this.modulesById.get(moduleId)
  }

  /**
   * 全部模块，按 ID 排序。
   *
   * 排序而非按插入顺序返回，是为了让候选解析（它用 ID 做次级排序）无论构建工具
   * 以什么顺序 glob 到文件，都给出同一个答案。
   */
  getAll(): ModuleDefinition[] {
    return Array.from(this.modulesById.values())
      .sort((left, right) => left.id.localeCompare(right.id))
  }
}
