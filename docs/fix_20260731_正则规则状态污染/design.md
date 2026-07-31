# 正则规则状态污染修复设计

分支：`fix_20260731_正则规则状态污染`
基线：`main` @ `a1d16f7`

## 背景与问题

`RequestMatcher.url` 支持调用方直接传入 `RegExp`。当前 `matchesUrl()` 复用该实例执行
`matcher.url.test(request.url)`。JavaScript 的 `RegExp` 在带 `g` 或 `y` 标志时会把
匹配位置写入实例的 `lastIndex`，因此同一条规则重复判断相同 URL 会得到不同结果：

```text
/\/api\/users\//g

第 1 次 test(fullUrl) → true  → lastIndex = 34
第 2 次 test(fullUrl) → false → lastIndex = 0
第 3 次 test(fullUrl) → true  → lastIndex = 34
```

危险名单因此可能在第二次请求时从 `destructive` 间歇性降级；若请求方法是 GET，还可能
继续命中 `safe_method` 并直接放行。放行名单使用状态型正则时则会间歇性产生额外确认。

## 根因

- 策略引擎把调用方提供的 `RegExp` 当作不可变匹配条件，但直接调用了会修改实例状态的
  `.test()`。
- `evaluateRequest()` 文档声明策略判定是纯函数，实际却修改了规则对象中的 `lastIndex`。
- 现有正则测试只执行一次且不带 `g`/`y`，没有覆盖重复判定和调用方对象状态。

## 目标

- 同一条 `g` 或 `y` URL 正则重复判断相同请求时必须得到一致结果。
- 策略判定不得修改调用方正则的 `lastIndex`。
- 危险规则不得因共享正则状态从 `destructive` 间歇性降级。
- 保持普通正则、字符串 glob、method、`when()` 与判定顺序不变。
- 不改变公开类型或规则配置格式。

## 非目标

- 不改变 JavaScript 正则本身的匹配语义或 flags。
- 不新增正则缓存、规则预编译或配置校验框架。
- 不处理跨 realm 的 `RegExp` 识别问题。
- 不夹带 XHR、fetch、beacon 或确认 UI 修改。

## 推荐方案

仅对具有状态型标志的正则创建一次性副本，再在副本上执行 `.test()`：

```ts
function testRegExp(pattern: RegExp, value: string): boolean {
  const candidate = pattern.global || pattern.sticky
    ? new RegExp(pattern.source, pattern.flags)
    : pattern
  return candidate.test(value)
}
```

普通正则继续复用原实例，不增加分配；`g`/`y` 副本从 `lastIndex = 0` 开始并承接原
`source` 与全部 flags，既保持匹配语义，也不会读写调用方对象的状态。

## 数据流

```text
RequestMatcher.url
       │
       ├─ string ──→ compileUrlPattern() ──→ test(target)
       │
       └─ RegExp
            │
            ├─ 无 g/y ──→ 原实例 test(fullUrl)
            │
            └─ 有 g/y ──→ clone(source, flags) ──→ test(fullUrl)
                              │
                              └─ 原实例 lastIndex 保持不变
```

## 涉及文件

| 文件 | 操作 | 说明 |
|---|---|---|
| `packages/interceptor/src/policy.spec.ts` | 修改 | 增加 `g`/`y` 重复判定与状态不变回归测试 |
| `packages/interceptor/src/policy.ts` | 修改 | 状态型正则使用一次性副本进行匹配 |
| `docs/fix_20260731_正则规则状态污染/plan.md` | 新增 | TDD 与交付步骤 |
| `docs/fix_20260731_正则规则状态污染/test-results.md` | 新增 | 记录基线、红绿和完整验证结果 |
| `docs/fix_20260731_正则规则状态污染/review.md` | 新增 | 记录 scope、契约与独立复审结论 |

## 风险与回退

- 仅 `g`/`y` 正则每次判定多创建一个小对象；规则数量和请求判定频率下成本可控，且避免
  引入需要生命周期管理的缓存。
- 状态型正则不再承接调用方预设的 `lastIndex`。策略规则本应描述 URL 是否匹配，而不是
  依赖上一次请求留下的游标；这是恢复确定性契约，不是兼容性破坏。
- 回退只需撤销本 PR，不涉及数据、配置和公开 API 迁移。

## 验收标准

1. `g` URL 正则连续三次判断相同危险请求，三次均返回 `destructive`。
2. `y` URL 正则连续三次判断相同危险请求，三次均返回 `destructive`。
3. 单次判断后调用方正则的 `lastIndex` 不变。
4. 现有 30 个 policy 测试和其他 interceptor 测试不回归。
5. `npm run verify` 全部通过。
