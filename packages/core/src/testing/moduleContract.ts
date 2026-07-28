import type { ModuleDefinition } from '../contracts/module'
import type { ToolDefinition } from '../contracts/tool'
import { isValidToolSunsetDate } from '../contracts/toolLifecycle'

export interface ModuleContractIssue {
  code: string
  path: string
  message: string
}

interface ModuleContractDefinitions {
  modules: ModuleDefinition[]
  tools: ToolDefinition[]
}

/**
 * 在 CI 里守住模块与工具的契约。
 *
 * 与 {@link ToolRegistry} 的构造校验互补：注册表管的是「能不能跑起来」，这里管的是
 * 「工程上该不该这么写」——比如 Schema 必须禁止额外字段、工具权限不得越出模块声明、
 * 每个工具都要有 owner 和生命周期。
 *
 * 收集而不抛出：一次跑完给出全部问题清单，让作者一轮改完。
 */
export function collectModuleContractIssues(
  definitions: ModuleContractDefinitions
): ModuleContractIssue[] {
  const issues: ModuleContractIssue[] = []
  const modulesById = new Map(definitions.modules.map(module => [module.id, module]))

  definitions.modules.forEach(module => {
    if (!definitions.tools.some(tool => tool.moduleId === module.id)) {
      issues.push({
        code: 'MODULE_WITHOUT_TOOL',
        path: `modules.${module.id}`,
        message: `模块 ${module.id} 至少需要声明一个工具`
      })
    }
  })

  definitions.tools.forEach(tool => {
    const toolPath = `tools.${tool.moduleId}.${tool.name}.v${tool.version}`
    const module = modulesById.get(tool.moduleId)

    if (!module) {
      issues.push({
        code: 'TOOL_MODULE_NOT_FOUND',
        path: toolPath,
        message: `工具 ${tool.name} 所属模块 ${tool.moduleId} 未注册`
      })
    } else {
      const outsidePermissions = (tool.permissions || [])
        .filter(permission => !module.permissions.includes(permission))
      if (outsidePermissions.length > 0) {
        issues.push({
          code: 'TOOL_PERMISSION_OUTSIDE_MODULE',
          path: `${toolPath}.permissions`,
          message: `工具权限超出模块声明: ${outsidePermissions.join(', ')}`
        })
      }
    }

    if (!Number.isSafeInteger(tool.version) || tool.version <= 0) {
      issues.push({
        code: 'TOOL_VERSION_INVALID',
        path: `${toolPath}.version`,
        message: '工具版本必须是正安全整数'
      })
    }

    if (!tool.owner || !tool.owner.trim()) {
      issues.push({
        code: 'TOOL_OWNER_INVALID',
        path: `${toolPath}.owner`,
        message: '工具必须声明非空 owner'
      })
    }

    if (!tool.lifecycle || !['active', 'deprecated'].includes(tool.lifecycle.status)) {
      issues.push({
        code: 'TOOL_LIFECYCLE_INVALID',
        path: `${toolPath}.lifecycle`,
        message: '工具必须声明有效生命周期'
      })
    } else if (
      tool.lifecycle.sunsetAt &&
      !isValidToolSunsetDate(tool.lifecycle.sunsetAt)
    ) {
      issues.push({
        code: 'TOOL_SUNSET_DATE_INVALID',
        path: `${toolPath}.lifecycle.sunsetAt`,
        message: '工具废弃日期必须是有效的 YYYY-MM-DD'
      })
    } else if (tool.lifecycle.status === 'deprecated') {
      const replacementName = tool.lifecycle.replacement
      const replacement = definitions.tools.find(candidate => {
        return `${candidate.moduleId}_${candidate.name}_v${candidate.version}` ===
          replacementName
      })
      if (!replacement || replacement.lifecycle?.status !== 'active') {
        issues.push({
          code: 'TOOL_REPLACEMENT_INVALID',
          path: `${toolPath}.lifecycle.replacement`,
          message: '废弃工具必须指向存在的 active 替代工具'
        })
      }
    }

    if ((tool.schema as { additionalProperties?: unknown }).additionalProperties !== false) {
      issues.push({
        code: 'TOOL_SCHEMA_ADDITIONAL_PROPERTIES',
        path: `${toolPath}.schema.additionalProperties`,
        message: '工具 Schema 必须显式禁止额外字段'
      })
    }
  })

  return issues.sort((left, right) => {
    return left.path.localeCompare(right.path) || left.code.localeCompare(right.code)
  })
}
