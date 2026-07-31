# 正则规则状态污染自审

## Scope

| 文件 | 状态 | 审查结论 |
|---|---|---|
| `packages/interceptor/src/policy.ts` | 修改 | 在单次 URL 正则判定内隔离并恢复匹配游标 |
| `packages/interceptor/src/policy.spec.ts` | 修改 | 增加 `g`/`y`、非零游标和 RegExp 子类测试 |
| `docs/fix_20260731_正则规则状态污染/*` | 新增 | 设计、计划、测试和审查记录 |

未修改公开类型、规则顺序、method、`when()`、glob、XHR、fetch、beacon 或确认 UI。

## 契约核对

| 验收项 | 证据 | 结论 |
|---|---|---|
| `g` 危险规则重复判定一致 | 同一策略连续判断三次，三次 reason 均为 `danger_list` | 通过 |
| `y` 危险规则重复判定一致 | 同一策略连续判断三次，三次 reason 均为 `danger_list` | 通过 |
| 不修改调用方 `lastIndex` | 从游标 7 判定后仍恢复为 7 | 通过 |
| 覆写 flags getter 不绕过隔离 | 子类隐藏内部 `g` 后三次仍命中危险规则 | 通过 |
| 保留子类自定义 `exec()` | `exec()` 恒返回 null 的规则仍不匹配 | 通过 |
| 普通正则行为不变 | 原有“不带状态标志的 RegExp”测试通过 | 通过 |
| glob 行为不变 | `*`、`**`、`:param`、锚定和元字符转义测试通过 | 通过 |
| 判定顺序不变 | 原有 danger/safe/allow/default 顺序测试通过 | 通过 |
| 无公开 API 变化 | 仅新增 `policy.ts` 内部辅助函数 | 通过 |

## 实现审查

- 状态污染发生在调用方正则对象本身；每次判定都从游标 0 开始，并在 `finally` 中恢复
  进入时的值，正常返回与抛错路径都不会留下游标状态。
- 不读取可被 RegExp 子类覆写的 `global`、`sticky`、`source` 或 `flags` getter，因此内部
  `g`/`y` 状态不会被伪装后绕过。
- 直接调用原对象的 `test()`，保留子类自定义 `test()` / `exec()` 行为，不改变既有契约。
- 不创建或缓存 RegExp 副本，避免语义丢失和新的共享游标生命周期。
- `matchesUrl()` 仍对直接 RegExp 使用完整 URL；字符串模式仍按现有规则选择 pathname 或
  完整 URL。

## 安全与性能

- 危险规则不会再在第二次命中时降级；安全判定保持确定性。
- 每次正则判定仅增加常数次 `lastIndex` 读写与 `try/finally`，没有额外正则编译或缓存。
- 不涉及权限模型、网络请求内容、数据库或外部 API。

## Scope 控制

- 未改变调用方正则 pattern、flags、自定义 `exec()` 或进入时的 `lastIndex`。
- 未处理跨 realm RegExp、规则预编译或规则格式校验。
- 未夹带其他已知问题修复。

## 自审结论

实现与修订后的设计一致，状态型正则的共享游标被限制在一次判定内部；原生正则、非零
游标和 RegExp 子类边界均有先失败后通过的回归证据。

## 独立代码审查

- 第一轮：Critical 无；Important 指出 RegExp 子类可绕过克隆分支，且克隆会丢失自定义
  `exec()` 语义。已按 TDD 增加回归测试，并改为保存/恢复原对象游标。
- 第二轮：待复审；Critical 与 Important 必须清零后才能推送。
