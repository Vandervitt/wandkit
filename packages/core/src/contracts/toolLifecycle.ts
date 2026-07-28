/**
 * 校验 `YYYY-MM-DD` 形态的下线日期。
 *
 * 借道 `toISOString()` 的往返比对，是为了拒绝 `2026-02-30` 这类看着合法、实则不存在
 * 的日期——`new Date()` 会把它静默滚到 3 月 2 日，只做正则匹配会放行。
 *
 * 按 UTC 解析，使结论不受运行机器所在时区影响。
 */
export function isValidToolSunsetDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}
