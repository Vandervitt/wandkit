import Ajv, { type ValidateFunction } from 'ajv'
import type { TSchema } from '@sinclair/typebox'

/**
 * 共享的 Ajv 实例。
 *
 * - `allErrors` —— 一次报出全部违规，让改 Schema 的作者一眼看完，而不是改一次
 *   重编一次只看到一个错。
 * - `strict: false` —— TypeBox 会产出 `title`、`description`、`$id` 这类注解关键字，
 *   strict 模式会直接拒绝。而这些注解恰恰是模型理解参数含义的依据，必须保留。
 */
const ajv = new Ajv({ allErrors: true, strict: false })

/**
 * 在注册时把工具 Schema 编译一次。
 *
 * @throws Schema 不是合法 JSON Schema 时抛出。
 */
export function compileSchema(schema: TSchema): ValidateFunction {
  return ajv.compile(schema)
}

/**
 * 校验模型给出的参数。
 *
 * 抛出的 message 里带着 Ajv 的原始细节（`data.companyId must be integer`），只供
 * 开发者和链路追踪使用。Runtime 从不把它转发给用户，而是替换成
 * {@link AirlockMessages.invalidInput}——内部字段路径既不可读，也带轻微信息泄漏。
 *
 * @throws `input` 不满足 Schema 时抛出。
 */
export function assertValidInput(validate: ValidateFunction, input: unknown): void {
  if (validate(input)) return

  const detail = ajv.errorsText(validate.errors, { separator: '; ' })
  throw new Error('Argument validation failed: ' + detail)
}
