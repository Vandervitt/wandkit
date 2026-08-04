/**
 * 测试期工具，通过 `toolairlock/testing` 单独导出。
 *
 * 与主入口分开，避免假 LLM、契约校验这类只在测试里用的代码进入生产包。
 */
export { FakeLlm } from './fakeLlm'
export { evaluateTrace } from './evalSuite'
export type {
  EvalCase,
  EvalResult,
  EvalIssue,
  ExpectedTaskOutcome
} from './evalSuite'
export { collectModuleContractIssues } from './moduleContract'

/**
 * Schema 编译与校验，供业务侧为自己的工具 Schema 写单测。
 *
 * 放在 testing 子入口而非主入口：生产代码不该直接碰它——工具的参数校验由
 * {@link ToolRegistry.validateInput} 统一负责，绕过注册表自行校验会漏掉废弃工具
 * 拦截等一并做掉的检查。
 */
export { compileSchema, assertValidInput } from '../registry/contractValidator'
