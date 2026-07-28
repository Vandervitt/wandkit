import type { ModuleDefinition } from '../contracts/module'

/** 通配全部权限。这类 RBAC 方案里的惯例写法。 */
const SUPER_PERMISSION = '*:*:*'

/**
 * 判断已授予的权限集是否满足要求。
 *
 * 语义刻意是**任一满足**而非全部满足：`required` 列的是各自都足以放行的权限
 * （比如一个管理员或运营都能用的工具），不是合取条件。
 *
 * 要求为空即公开。这在这里是安全的，因为权限管的是**暴露**——工具在模型看到之前
 * 就被过滤掉了——而后端始终是每次调用的真正裁决方。
 */
export function hasPermission(required: string[], granted: string[]): boolean {
  if (required.length === 0) return true
  if (granted.includes(SUPER_PERMISSION)) return true
  return required.some(permission => granted.includes(permission))
}

/**
 * 剔除当前用户无权访问的模块。
 *
 * 在候选解析之前执行，因此无权模块永远不可能被选中——哪怕别名精确命中也不行。
 */
export function filterAuthorizedModules(
  modules: ModuleDefinition[],
  permissions: string[]
): ModuleDefinition[] {
  return modules.filter(module => hasPermission(module.permissions, permissions))
}

/**
 * 剔除当前用户无权访问的工具。
 *
 * 这是最小权限原则的承重步骤：无权的工具压根不在模型的工具清单里，因此模型既无法
 * 提议它，也无法靠幻觉调用它，更不会把它当作可用选项告诉用户。
 *
 * 对元素类型做了泛型，因此既能作用于原始定义，也能作用于 Runtime 组装出来的
 * `{ functionName, tool, schema }` 记录。
 */
export function filterAuthorizedTools<T extends { permissions?: string[] }>(
  tools: T[],
  permissions: string[]
): T[] {
  return tools.filter(tool => hasPermission(tool.permissions ?? [], permissions))
}
