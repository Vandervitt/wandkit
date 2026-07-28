/**
 * 递归深拷贝纯数据。
 *
 * 刻意保持极简，因为它只服务于本包内部流转的两类结构：LLM 消息和工具参数。两者都是
 * 已经或即将 JSON 序列化的纯数据，不含 Date、Map、Set、循环引用或原型链。
 *
 * 没有用 `structuredClone`：它在 Node 17 以下和部分老浏览器里缺席，而本包要能塞进
 * 相当古老的 toB 前端环境。也没有用 `JSON.parse(JSON.stringify())`：那会把
 * `undefined` 字段悄悄抹掉，而工具参数里的可选字段有无是有语义的。
 *
 * 用途集中在两处：一是不让调用方持有 Runtime 内部历史的引用（拿到就能改），二是
 * 保证确认时重跑 `prepare` 用的是与首次完全独立的一份参数。
 */
export function deepClone<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(item => deepClone(item)) as unknown as T
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>
    return Object.keys(source).reduce<Record<string, unknown>>((copy, key) => {
      copy[key] = deepClone(source[key])
      return copy
    }, {}) as T
  }
  return value
}
