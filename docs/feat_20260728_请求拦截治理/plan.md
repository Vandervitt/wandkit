# 请求拦截治理 —— 实施计划

> 配套设计：[design.md](./design.md)

## 阶段划分

| 阶段 | 内容 | 交付判据 | 状态 |
|---|---|---|---|
| 0 | 设计文档 + 类型骨架 | `npm run typecheck` 通过，接口签名定稿 | ✅ 完成 |
| 1 | 判定策略引擎 | 判定顺序 6 条规则全覆盖单测 | ✅ 完成（30 单测） |
| 2 | fetch / XHR / form 拦截 | 挂起—放行—拒绝三条链路可跑 | 下一步 |
| 3 | 归属判定 + 已授权窗口 | 用户操作不弹卡；路径 A 不双重确认 | 待办 |
| 4 | 与 ui 包接线 + 可运行样例 | `examples/03-interceptor.ts` | 待办 |
| 5 | ExecutorPort + page-agent 适配器 | 端到端：自由操作被闸门拦下 | 待办 |
| 6 | trace 接入 + README 定位改写 | 审计闭环，文档与实现一致 | 待办 |

阶段 3 的「已授权窗口」是**必做项**，不是优化：不做则每写一个声明式工具反而多一次确认。

## 阶段 0（本轮）文件清单

```
docs/feat_20260728_请求拦截治理/
  design.md
  plan.md
packages/interceptor/
  package.json
  tsconfig.json
  tsup.config.ts
  src/
    index.ts          导出面
    types.ts          InterceptedRequest / Verdict / 规则与匹配
    policy.ts         判定策略（签名 + 顺序常量，实现留空）
    attribution.ts    AttributionPort + 遮罩绑定
    authorization.ts  已授权窗口
    interceptor.ts    install/uninstall 骨架
```

## 阶段 1 测试矩阵（判定顺序）

按 design.md §5.1 的六条，每条至少一例，另加边界：

| # | 场景 | 期望 |
|---|---|---|
| 1 | 非 Agent 发起的 DELETE | `allow` |
| 2 | 已授权窗口内的 POST | `allow` |
| 3 | Agent 发起的 GET | `allow` |
| 4 | 同时命中名单 A 与名单 B | `confirm` as `destructive`（**B 优先**） |
| 5 | 仅命中名单 A 的 POST | `allow` |
| 6 | 未命中任何名单的 PUT | `confirm` as `write`（默认拒绝） |
| 7 | 名单 B 的 `when()` 返回 false | 退回后续判定，不强判 destructive |
| 8 | 未知方法（如 `PROPFIND`） | 按非安全方法处理 → `confirm` |

第 4 条是核心回归用例，必须显式覆盖——它守的是「宽泛放行规则不得盖过高危规则」。

### 实施后补充的用例

实现阶段发现两处原矩阵未覆盖、但影响安全语义的点，已补：

| # | 场景 | 期望 | 为什么重要 |
|---|---|---|---|
| 9 | 危险名单命中 GET | `confirm` as `destructive` | 导出类接口无副作用却外泄数据；据此把 `danger_list` 提到 `safe_method` 之前 |
| 10 | 危险规则 `when()` 抛错 | 视为**命中** | 规则写坏不得导致高危动作被放过 |
| 11 | 放行规则 `when()` 抛错 | 视为**未命中** | 同上，两个方向都朝「更需要确认」倒 |
| 12 | 规则求值异常上报 | 触发 `onRuleError` | 一直抛错的规则会持续偏移判定，不能静默 |
| 13 | glob `*` 不跨 `/`、`**` 跨 `/`、整体锚定、元字符转义 | 各自钉死 | 直接决定放行规则的真实覆盖面 |

## 风险与对策

| 风险 | 对策 |
|---|---|
| `sendBeacon` 无法挂起 | 默认拒发 + 告警；文档显著提示 |
| XHR 同步时序被破坏 | 记为已知限制，提供 `passthrough` 逃生配置 |
| 宽限期误判用户操作为 Agent | `graceMs` 默认取小（500ms），可配 |
| 已授权窗口过粗 | 文档写明不防御「工具行为不符合声明」 |
| Prompt injection 面扩大 | 默认拒绝兜底；执行器工具须可被权限过滤 |
| 拦截器可被绕过 | 明确非目标：防误操作，不防恶意宿主 |

## 验证门槛

沿用项目现有门槛：`npm run verify`（test + typecheck + build）。阶段 4 起追加 `npm run example:interceptor` 冒烟。
