import Fuse from 'fuse.js'
import type { ModuleDefinition } from '../contracts/module'
import { MAX_CANDIDATE_MODULES } from './budget'
import { filterAuthorizedModules } from './permissionFilter'

export interface ResolveCandidatesOptions {
  /** 本轮用户的原始输入。 */
  text: string
  /** 用户当前所在路由（宿主暴露了路由能力时）。 */
  routeName?: string
  /** 全部已注册模块，尚未做权限过滤。 */
  modules: ModuleDefinition[]
  /** 当前用户的权限串。 */
  permissions: string[]
  /** 工具通过 `ctx.activateModules` 显式激活的模块。 */
  activatedModuleIds?: string[]
  /** 上一轮的候选模块。 */
  previousModuleIds?: string[]
  /**
   * 候选上限，缺省 {@link MAX_CANDIDATE_MODULES}。
   *
   * 传入模块总数即「全局接入」——任何模块都不会因为措辞没撞上别名、或用户恰好停在
   * 别的页面而够不到。代价是模型每轮要在更多工具里挑，选错概率随之上升，所以这是
   * 一个由宿主按自身模块规模权衡的开关，而不是默认行为。
   */
  limit?: number
}

/**
 * 决定本轮暴露哪些模块——完全在本地完成，不产生任何模型调用。
 *
 * 这是两段式路由里便宜的那一半。常见的替代方案是先用一次「路由」LLM 调用收窄范围，
 * 再发真正的请求，代价是每次请求都多一整个网络往返的延迟。而别名子串匹配加模糊搜索
 * 能零成本解决绝大多数表述，模型仍然握有最终决定权——它在被暴露的工具里挑。
 *
 * 各路信号严格按优先级依次应用，边加边去重：
 *
 * 1. **别名精确命中** —— 用户点名了这个领域，没有什么该排在它前面。
 * 2. **显式激活的模块** —— 有工具声明了后续工作落在这里。
 * 3. **上一轮的模块** —— 对话连续性。
 * 4. **当前路由** —— 意图的弱证据。
 * 5. **模糊匹配** —— 在标题、描述、别名、示例上搜。
 * 6. **其余全部有权限的模块**（按 id）—— 保证任何模块都够得到。
 *
 * 第 6 档是「全局可达」的落点：前五档都是排序信号，谁都没命中时不该让候选变成空集。
 * 实测中「这通电话是谁打的」这类不含关键词的表述，在无关页面上会拿到空候选，
 * Copilot 于是彻底哑火——而那正是用户最需要它的时候。上限由 `limit` 决定切在哪里，
 * 而不是由「有没有匹配上信号」决定谁进得来。
 *
 * 连续性（2、3）刻意压过当前路由：多轮追问时用户经常还停在当初随手打开的那个页面上，
 * 让路由取胜会把真正正在讨论的模块挤出候选，「看第 3 页」这类追问就断了。
 *
 * @returns 模块 ID，按相关度从高到低，上限为 {@link MAX_CANDIDATE_MODULES}。
 *   无权限的模块永远不会出现。
 */
export function resolveCandidates(_options: ResolveCandidatesOptions): string[] {
  const {
    text,
    routeName,
    modules,
    permissions,
    activatedModuleIds = [],
    previousModuleIds = [],
    limit = MAX_CANDIDATE_MODULES
  } = _options
  const authorizedModules = filterAuthorizedModules(modules, permissions)
  const authorizedIds = new Set(authorizedModules.map(module => module.id))
  const candidates: string[] = []

  /** 有权限且未收录时追加；先到先得，从而保住优先级顺序。 */
  const add = (moduleId: string): void => {
    if (!authorizedIds.has(moduleId) || candidates.includes(moduleId)) return
    candidates.push(moduleId)
  }

  // 1. 别名子串精确命中。同分按 ID 排序，保证结果稳定。
  authorizedModules
    .filter(module => module.aliases.some(alias => alias && text.includes(alias)))
    .sort((left, right) => left.id.localeCompare(right.id))
    .forEach(module => add(module.id))

  // 2、3. 对话连续性，排在当前路由之前：多轮追问时用户常常停在一个无关页面上，
  // 让路由取胜会把真正在讨论的模块挤出去。
  activatedModuleIds.forEach(add)
  previousModuleIds.forEach(add)

  // 4. 用户眼下正看着的页面。
  if (routeName) {
    authorizedModules
      .filter(module => module.routes.includes(routeName))
      .sort((left, right) => left.id.localeCompare(right.id))
      .forEach(module => add(module.id))
  }

  // 5. 模糊兜底。阈值 0.6 放得比较松，因为能走到这一步说明所有精确信号都没命中，
  // 而给一个模型可以无视的弱候选，总好过一个候选都没有。
  if (text.trim()) {
    const fuse = new Fuse(authorizedModules, {
      keys: ['title', 'description', 'aliases', 'examples'],
      includeScore: true,
      threshold: 0.6
    })
    fuse.search(text)
      // Fuse 对同分项不保证顺序稳定；用 ID 做次级排序，保证相同输入产出相同 Prompt，
      // 这对可复现性和厂商侧的 Prompt 缓存都有意义。
      .sort((left, right) => {
        const scoreDifference = (left.score ?? 1) - (right.score ?? 1)
        return scoreDifference || left.item.id.localeCompare(right.item.id)
      })
      .forEach(result => add(result.item.id))
  }

  // 6. 兜底：其余有权限的模块按 id 补齐。排在所有命中信号的模块之后，因此
  // limit 收窄时最先被切掉的永远是最不相关的那些。
  authorizedModules
    .map(module => module.id)
    .sort((left, right) => left.localeCompare(right))
    .forEach(add)

  return candidates.slice(0, limit)
}
