import type { ModuleDefinition } from '../contracts/module'
import type { ToolDefinition } from '../contracts/tool'

/**
 * 与 webpack `require.context` / Vite `import.meta.glob` 兼容的最小上下文形状。
 *
 * 由宿主应用负责产出；本包只消费它，不绑定任何构建工具——这也是为什么包里没有
 * 「发现入口」函数，`require.context` 是 webpack 专有语法，写进来就绑死了打包器。
 */
export interface WebpackContext {
  keys(): string[]
  <T = any>(key: string): { default?: T } | T
}

/** 自动发现的产物：模块定义与工具定义。 */
export interface DiscoveredDefinitions {
  modules: ModuleDefinition[]
  tools: ToolDefinition[]
}

/**
 * 从构建工具的模块上下文中按 key 排序取出默认导出，同时兼容 `export default`
 * 与直接导出两种写法。
 *
 * 排序保证了工具注册顺序与文件系统枚举顺序无关，从而让发给模型的工具清单稳定。
 *
 * 宿主侧的发现入口自行实现，例如 webpack：
 * ```ts
 * const definitions = {
 *   modules: loadDefaults<ModuleDefinition>(require.context('./modules', true, /module\.ts$/)),
 *   tools: loadDefaults<ToolDefinition>(require.context('./modules', true, /\.tool\.ts$/))
 * }
 * ```
 *
 * Vite 侧把 `import.meta.glob` 的结果包一层即可：
 * ```ts
 * const files = import.meta.glob('./modules/**\/*.tool.ts', { eager: true })
 * loadDefaults<ToolDefinition>(Object.assign(
 *   (key: string) => files[key],
 *   { keys: () => Object.keys(files) }
 * ) as unknown as WebpackContext)
 * ```
 */
export function loadDefaults<T>(context: WebpackContext): T[] {
  return context.keys().sort().map((key) => {
    const loaded = context<T>(key)
    return loaded && typeof loaded === 'object' && 'default' in loaded
      ? (loaded as { default: T }).default
      : loaded as T
  })
}
