# Fetch 请求规范化自审

## Scope

| 文件 | 状态 | 审查结论 |
|---|---|---|
| `packages/interceptor/src/interceptor.ts` | 修改 | 仅调整 fetch 请求的只读投影 |
| `packages/interceptor/src/interceptor.spec.ts` | 修改 | 增加 4 个同根因回归测试 |
| `docs/fix_20260731_Fetch请求规范化/*` | 新增 | 设计、计划、测试和审查记录 |

未修改 XHR、beacon、策略顺序、风险等级和公开类型。

## 契约核对

| 验收项 | 证据 | 结论 |
|---|---|---|
| Request 自带 JSON body 参与判定 | 危险规则与宽泛 allow 同时存在的拒绝测试 | 通过 |
| 跨 realm Request 保留 method、URL、headers | 替换当前 realm 的 Request/Headers 构造器后测试 | 通过 |
| 原 Request 不被提前消费 | 原始 fetch 收到时 `bodyUsed === false` 且能读取完整文本 | 通过 |
| clone/read 失败从严 | clone 抛错时 confirm 与原始 fetch 均未调用 | 通过 |
| `init` 覆盖优先级 | method、headers 保持 `init ?? Request`；body 显式存在时使用 init | 通过 |
| 原 fetch 形态不变 | `original.apply(this, args)` 未修改 | 通过 |
| 无公开 API 变化 | 新增函数均为模块内部函数 | 通过 |

## 实现审查

- `isRequestLike()` 只依赖 `url`、`method`、`headers`、`clone` 能力，避免跨 realm
  `instanceof` 假阴性。
- Headers 在排除数组后通过标准 `forEach` 读取，跨 realm Headers 不依赖当前构造器；
  tuple 数组和普通 record 保留原分支。
- 只在 Request 确实有 body 且 `init` 未提供 body 时读取 `request.clone().text()`，原始
  Request 继续原样传给原 fetch。
- clone 或文本读取抛错会让 patched fetch 直接 reject，判定和网络发送均不会发生，符合
  治理层从严策略。
- 性能成本是一份 Request body 的 clone 与文本解码，仅发生在 interceptor 接管且 Request
  自带 body 的调用上；未引入缓存、重试或额外公共抽象。

## 结论

实现与设计一致，未发现需要夹带到本 PR 的额外修改。后续 XHR 确认竞态和正则状态污染
继续按独立 PR 处理。
