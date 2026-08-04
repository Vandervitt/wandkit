# 多实例卸载竞态修复设计

分支：`fix_20260731_多实例卸载竞态`
基线：`main` @ `3b7e145`

## 背景与问题

`@wandkit/interceptor` 通过替换浏览器的 `fetch`、
`XMLHttpRequest.prototype.open/send` 和 `navigator.sendBeacon` 安装请求闸门。每次安装都
保存当时的旧函数，卸载时再直接把旧函数写回。

单实例安装与卸载时该逻辑成立；多个实例或热更新周期叠加时，旧引用会形成 patch 链：

```text
A.install()  → fetch = wrapperA(previous = browserFetch)
B.install()  → fetch = wrapperB(previous = wrapperA)
```

此时先卸载 A，当前实现会直接执行 `fetch = browserFetch`，从而静默拆掉仍然激活的 B。
若先卸载 B 再卸载 A，或者外部代码在 B 之后继续替换 API，还可能重新暴露已卸载的旧
wrapper 或覆盖外部实现。

XHR 的后果更严重：当前 patch 只有等待确认的 continuation 检查 `active`。失活 wrapper
本身被后续层调用时仍会重新判定，最终因为 `active === false` 不调用前一层 `send()`，
因此请求会被吞掉。

这与公开注释中“SPA 热更新、测试之间可完全卸载”的承诺冲突，也使两个独立 interceptor
实例无法安全共存。

## 根因

- 每个实例只知道安装时捕获的前一层函数，不知道该函数后来是否已经失活。
- 卸载闭包无条件恢复旧引用，没有确认自己是否仍是当前顶层 patch。
- wrapper 没有“失活后透明透传”的调用语义。
- Fetch、XHR、Beacon 各自直接保存和恢复函数，没有统一的 patch 生命周期契约。
- XHR 的 `open`、`send` 属于同一安装层，但当前没有可供恢复逻辑识别的共享生命周期。

## 目标

1. 多个激活实例按安装链依次判定；后安装实例先判定，再进入前一激活实例。
2. 卸载任意实例只移除该实例的治理效果，不拆除其他激活实例。
3. 失活 wrapper 被其他 wrapper 或外部代码继续持有时必须透明透传，不再解析、判定、
   记录 trace 或生成请求 ID。
4. 最后一层本库 patch 卸载后，在没有外部覆盖时严格恢复安装前的浏览器函数引用。
5. 外部代码后来替换浏览器 API 时，本库卸载不得覆盖外部实现。
6. XHR 的 `open` 与 `send` 同步失活，等待确认期间卸载仍必须使旧 continuation 作废。
7. 不改变公开 API、策略顺序、确认顺序和单实例行为。

## 已确认的多实例语义

多个 interceptor 实例不是“后者取代前者”，而是独立治理层。A、B 都激活时，请求必须
依次经过两个闸门：

```text
request → wrapperB → gateB → wrapperA → gateA → browser API
```

任意一层拒绝，请求都不得进入更早的函数。卸载 A 后只剩 B 判定；卸载 B 后只剩 A
判定。

## 方案比较

### 方案一：带元数据的透明 patch 链（采用）

每层 wrapper 记录前一层引用、通道类型和共享生命周期。卸载先使本层失活；失活 wrapper
被调用时直接进入前一层。只有当前浏览器 API 仍指向本层 wrapper 时才恢复，并在恢复时
跳过连续失活的本库 wrapper。

该方案保留现有嵌套调用结构，改动集中，能直接兼容多实例和后安装的外部 wrapper。

### 方案二：全局 patch 调度器

每个 API 只保留一个公共 wrapper，各 interceptor 注册到全局实例栈。生命周期集中，但
需要新增跨实例、跨 bundle 的注册中心，并重新定义异步判定链、XHR 状态和外部 patch
互操作，明显扩大本次修复范围。

### 方案三：仅在当前函数等于自己的 wrapper 时恢复

该方案只能防止旧实例直接覆盖新顶层。旧 wrapper 仍会留在调用链，XHR 失活层仍可能
吞请求，反向卸载也可能恢复失活函数，不能解决根因。

## 推荐设计

### Patch 元数据

在模块内部使用 `Symbol.for('@wandkit/interceptor.patch')` 标记本库 wrapper。使用全局
symbol 而不是模块内 `WeakMap`，使同一页面加载多个打包副本时仍能识别彼此的 patch 层。

元数据包含：

```ts
interface PatchLifecycle {
  active: boolean
}

interface PatchMetadata {
  source: '@wandkit/interceptor'
  kind: 'fetch' | 'xhr-open' | 'xhr-send' | 'beacon'
  lifecycle: PatchLifecycle
  previous: Function
}
```

读取元数据时校验品牌、通道、`previous` 和生命周期形态。外部代码即使碰巧使用同一个
symbol，只要结构不符合预期，就按普通外部函数处理，不沿链跳过。

### 激活与失活调用

- 激活的 Fetch wrapper 解析请求、执行自己的 gate，批准后调用 `previous`。
- 激活的 Beacon wrapper 执行同步判定，允许时调用 `previous`。
- 激活的 XHR `open` 记录本层状态后调用前一层 `open`；激活的 `send` 判定通过后调用
  前一层 `send`。
- 失活 wrapper 不执行任何本层副作用，直接以原 `this` 和原参数调用 `previous`。
- XHR 每个 patch 层拥有独立 `WeakMap<XMLHttpRequest, XhrCallState>`，避免不同实例互相
  覆盖用于 continuation 校验的状态对象。

XHR 的 `open` 和 `send` wrapper 共享同一个 `PatchLifecycle`，因此卸载时同时失活；
已经开始等待的确认仍使用该生命周期与状态对象身份双重校验，卸载或重新 `open()` 后都
不得发送。

### 安全恢复

每个 restore 按以下顺序执行：

1. 将本层生命周期设置为 `active = false`。
2. 检查对应浏览器 API 当前是否仍严格等于自己的 wrapper。
3. 若不相等，说明有更新的本库层或外部层，停止写回；失活 wrapper 负责未来透明透传。
4. 若相等，沿 `previous` 跳过通道相同且已经失活的本库 wrapper。
5. 恢复到最近的激活本库层或第一个普通函数。

解链过程记录已访问函数；若遇到重复引用则停止解链，把当前函数视为外部边界，避免异常
元数据或第三方冲突制造无限循环。

XHR 的 `open`、`send` 分别执行第 2～5 步。外部代码可能只替换其中一个方法，因此不能
把二者是否恢复绑定成一个条件。

## 生命周期数据流

正常叠加：

```text
A.install → A(active)
B.install → B(active, previous=A)

request → B gate → A gate → browser
```

先卸载旧实例 A：

```text
A.active = false
current === B，因此不改写全局 API

request → B gate → A(inactive，透明透传) → browser
```

随后卸载 B：

```text
B.active = false
current === B
previous A 已失活，跳过 A
current = browser
```

外部 wrapper 后安装：

```text
A → B → External（当前函数）

A/B uninstall → 仅标记失活，不覆盖 External
External 调用旧引用 → 失活层透明透传 → browser
```

若外部代码以后主动恢复其早先捕获的旧 wrapper，函数属性上可能重新出现失活层。本库
不能在不覆盖外部生命周期决策的情况下提前改写它；该失活层仍会透明透传，因此不会恢复
已卸载实例的治理行为或吞掉请求。

## 错误处理与兼容性

- 元数据识别失败时停止解链，将该函数视为外部边界，不猜测也不改写。
- 元数据形成循环时停止解链，不在卸载路径无限遍历。
- 失活透传保持原 `this`、参数和同步/异步返回形态；不捕获前一层异常。
- 激活层继续沿用现有从严策略：解析或判定失败不能静默放行。
- 多层 gate 串行执行，保持现有 wrapper 嵌套顺序，不并行弹出多个确认。
- 单实例重复安装、卸载闭包幂等和 `installed` 状态语义保持不变。

## 涉及文件

| 文件 | 操作 | 说明 |
|---|---|---|
| `packages/interceptor/src/interceptor.ts` | 修改 | 增加 patch 元数据、透明失活调用、安全恢复和 XHR 分层状态 |
| `packages/interceptor/src/interceptor.spec.ts` | 修改 | 增加 Fetch 多实例、卸载顺序和外部 wrapper 回归测试 |
| `packages/interceptor/src/channels.spec.ts` | 修改 | 增加 XHR、Beacon 多实例和外部 wrapper 回归测试 |
| `docs/fix_20260731_多实例卸载竞态/plan.md` | 新增 | 记录 TDD 与交付步骤 |
| `docs/fix_20260731_多实例卸载竞态/test-results.md` | 新增 | 记录红绿测试与完整验证结果 |
| `docs/fix_20260731_多实例卸载竞态/review.md` | 新增 | 记录契约核对和独立复审结论 |

## 测试策略

先新增会在当前实现失败的回归测试，再修改业务代码：

1. Fetch：A、B 安装后先卸载 A，B 仍判定且 A 不再判定；再卸载 B 严格恢复基线函数。
2. Fetch：按 B、A 的 LIFO 顺序卸载同样正确。
3. Fetch：B 拒绝时不得进入失活 A 或浏览器实现。
4. Fetch：外部 wrapper 后安装时，A/B 卸载不得覆盖它；外部持有的失活 wrapper 只透传。
5. XHR：覆盖 A/B 两种卸载顺序，并验证 `open`、`send` 均不会被失活层吞掉或重复判定。
6. XHR：等待确认期间卸载仍使 continuation 失效。
7. XHR：外部只替换 `open` 或只替换 `send` 时，本库分别安全恢复。
8. Beacon：覆盖多实例、两种卸载顺序、失活透传和外部 wrapper。
9. 保持现有单实例、重复安装、重复卸载和请求解析测试通过。

完成目标测试后执行 interceptor 相关全量测试及 `npm run verify`。提交和推送前进行独立
代码复审；Critical/Important 问题必须为 0。

## 非目标

- 不增加或改变公开 API。
- 不引入全局 interceptor 实例注册中心。
- 不改变策略匹配、风险级别、确认 UI、trace 内容或通道默认值。
- 不改变 XHR `send()` 同步返回但实际发送延后的既有限制。
- 不负责修复外部库恢复其自身过期函数引用的生命周期行为。
- 不处理 `<form>`、WebSocket、SSE 等尚未纳入当前 patch 的通道。

## 风险与回退

- 多实例会串行执行多个激活 gate，这是已经确认的治理语义；实例越多，请求确认链越长。
- `Symbol.for` 元数据是进程内私有协作协议，不进入公开类型或构建导出。
- 每次恢复只遍历连续的本库失活层，复杂度与叠加层数线性相关；正常安装层数很小。
- 回退只需撤销本 PR，不涉及数据、配置或公开契约迁移。

## 验收标准

1. A、B 同时激活时，两层按 `B → A` 顺序判定。
2. 任意顺序卸载 A、B，都不会拆除仍激活实例或恢复已失活治理行为。
3. 最后一层卸载后，Fetch、XHR `open/send`、Beacon 严格恢复各自安装前的函数引用。
4. 失活 wrapper 被继续调用时不判定、不记录、不生成请求 ID，只透明透传。
5. 后安装的外部 wrapper 不会被本库卸载覆盖。
6. XHR 等待确认期间卸载或重新 `open()` 后，旧 continuation 不会发送。
7. 现有 interceptor 行为与公开 API 不回归。
8. `npm run verify` 全部通过，独立复审无 Critical/Important 问题。
