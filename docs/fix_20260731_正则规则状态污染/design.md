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
- 保留 `RegExp` 子类覆写的 `test()` / `exec()` 匹配行为，不依赖可覆写的 flags getter。
- 保持普通正则、字符串 glob、method、`when()` 与判定顺序不变。
- 不改变公开类型或规则配置格式。

## 非目标

- 不改变正则的 pattern、flags 或子类自定义匹配行为；策略判定固定从游标 0 开始。
- 不新增正则缓存、规则预编译或配置校验框架。
- 不处理跨 realm 的 `RegExp` 识别问题。
- 不夹带 XHR、fetch、beacon 或确认 UI 修改。

## 推荐方案

对原正则对象执行 `.test()`，但把一次策略判定使用的匹配游标隔离在调用内部：进入前
保存调用方 `lastIndex` 并从 0 开始，离开时在 `finally` 中恢复原值。

```ts
function testRegExp(pattern: RegExp, value: string): boolean {
  const lastIndex = pattern.lastIndex
  try {
    if (lastIndex !== 0) pattern.lastIndex = 0
    return pattern.test(value)
  } finally {
    if (pattern.lastIndex !== lastIndex) pattern.lastIndex = lastIndex
  }
}
```

该方案不读取可能被子类覆写的 `global`、`sticky`、`source` 或 `flags` getter，也不把
子类克隆成普通 RegExp，因此既能处理内部带 `g`/`y` 的实例，又保留其自定义 `exec()`
语义。`finally` 保证正常返回或抛错时都恢复调用方游标。

## 数据流

```text
RequestMatcher.url
       │
       ├─ string ──→ compileUrlPattern() ──→ test(target)
       │
       └─ RegExp
            │
            ├─ 保存原 lastIndex
            ├─ 本次判定游标设为 0
            ├─ 原实例 test(fullUrl)（保留子类 exec）
            └─ finally 恢复原 lastIndex
```

## 涉及文件

| 文件 | 操作 | 说明 |
|---|---|---|
| `packages/interceptor/src/policy.spec.ts` | 修改 | 增加 `g`/`y`、非零游标和 RegExp 子类回归测试 |
| `packages/interceptor/src/policy.ts` | 修改 | 在单次判定内隔离并恢复正则匹配游标 |
| `docs/fix_20260731_正则规则状态污染/plan.md` | 新增 | TDD 与交付步骤 |
| `docs/fix_20260731_正则规则状态污染/test-results.md` | 新增 | 记录基线、红绿和完整验证结果 |
| `docs/fix_20260731_正则规则状态污染/review.md` | 新增 | 记录 scope、契约与独立复审结论 |

## 风险与回退

- 不创建新 RegExp 或缓存；每次正则判定只增加常数次游标读写与 `try/finally`。
- 策略匹配固定从游标 0 开始，但调用结束后恢复调用方预设的非零 `lastIndex`。规则本应
  描述 URL 是否匹配，而不是依赖上一次请求留下的游标。
- 回退只需撤销本 PR，不涉及数据、配置和公开 API 迁移。

## 验收标准

1. `g` URL 正则连续三次判断相同危险请求，三次均返回 `destructive`。
2. `y` URL 正则连续三次判断相同危险请求，三次均返回 `destructive`。
3. 单次判断从游标 0 开始，并在结束后恢复调用方原有的非零 `lastIndex`。
4. 覆写 `global` getter 的 RegExp 子类仍不会状态污染。
5. RegExp 子类自定义 `exec()` 语义保持不变。
6. 现有 30 个 policy 测试和其他 interceptor 测试不回归。
7. `npm run verify` 全部通过。
