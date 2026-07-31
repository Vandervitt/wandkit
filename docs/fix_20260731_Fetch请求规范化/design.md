# Fetch 请求规范化修复设计

分支：`fix_20260731_Fetch请求规范化`
基线：`main` @ `8657612`

## 背景与问题

`@toolairlock/interceptor` 在接管 `fetch` 时，需要先把调用参数投影成
`InterceptedRequest`，再交给危险名单、放行名单和确认界面使用。当前实现存在两处同源缺陷：

1. 只读取 `RequestInit.body`，忽略 `Request` 对象自身的 body。依赖 body 的危险规则会
   看见 `undefined`，随后可能被宽泛放行规则直接放过。
2. 用当前 realm 的全局 `Request` 做 `instanceof`。来自 iframe 或其他 window 的真实
   `Request` 不满足该判断，会被降级成 `GET [object Request]`，从安全方法分支直接放行。

两者的结构性根因都是：请求解析依赖当前 realm 的构造器和第二参数，而没有按 Fetch 的
最终有效请求形态统一读取输入。

## 目标

- 对字符串、URL、同 realm Request、跨 realm Request 使用一致的解析语义。
- `RequestInit` 显式提供的 method、headers、body 继续优先于 Request 自带值。
- 读取 Request body 时只消费 `clone()`，不得让真正发送的原 Request 变成 `bodyUsed`。
- 无法复制或读取请求体时从严失败，不得在信息不完整时继续判定并放行。
- 不改变原始 `fetch` 的参数、`this` 绑定、返回值和实际发送对象。

## 非目标

- 不处理 XHR 等待确认期间重新 `open()` 的竞态；该问题由下一独立 PR 修复。
- 不扩展 FormData、Blob、ArrayBuffer 的展示格式。
- 不调整规则判定顺序或风险等级。
- 不修改公开 API。

## 推荐方案

### 1. 用结构能力识别 Request，而不是跨 realm 不可靠的 instanceof

新增内部 `isRequestLike()`，只识别 Fetch Request 必需且稳定的只读能力：

- `url: string`
- `method: string`
- `headers`
- `clone(): Request`

该函数仅用于读取请求元数据，不把对象暴露给规则或确认回调。

### 2. 统一解析优先级

```text
fetch(input, init)
        │
        ├─ method  = init.method  ?? request.method ?? GET
        ├─ headers = init.headers ?? request.headers
        └─ body
             ├─ init 显式声明 body → 解析 init.body
             ├─ Request 没有 body  → undefined
             └─ Request 有 body    → clone().text() → JSON/文本解析
```

### 3. 跨 realm Headers 采用能力读取

Headers 同样不能依赖当前 realm 的 `instanceof Headers`。若对象提供标准 `forEach`，按
Headers 读取；数组和普通对象继续走现有分支。

## 数据流

```text
调用方 Request / URL / string
            │
            ▼
     patchedFetch 原参数
            │
            ▼
  toInterceptedRequest（只读投影）
     │ method / url / headers
     │ clone 后读取 body
     ▼
  InterceptedRequest ──→ policy ──→ confirm / allow / deny
            │
            └──────────────────────→ original.fetch(...原参数)
```

## 涉及文件

| 文件 | 操作 | 说明 |
|---|---|---|
| `packages/interceptor/src/interceptor.ts` | 修改 | Request/Headers 跨 realm 识别与 body 克隆读取 |
| `packages/interceptor/src/interceptor.spec.ts` | 修改 | 增加两个失败回归场景及原 body 未被消费断言 |
| `docs/fix_20260731_Fetch请求规范化/plan.md` | 新增 | 红绿测试和交付步骤 |
| `docs/fix_20260731_Fetch请求规范化/test-results.md` | 新增 | 实施后记录真实验证输出 |
| `docs/fix_20260731_Fetch请求规范化/review.md` | 新增 | 实施后记录契约与 diff 自审 |

## 风险与回退

- 读取 Request body 会增加一次内存中的 clone 和文本解码，只发生在被 interceptor 接管的
  fetch 上；它换取的是内容规则能够看到真实请求体。
- clone/read 抛错时请求不会发出，符合治理层“信息不完整时从严”的原则。
- 回退只需撤销本 PR；不涉及数据迁移和外部状态。

## 验收标准

1. Request 自带 JSON body 能被危险规则识别，宽泛放行规则不能覆盖它。
2. 当前全局 Request 构造器不同于输入对象所属 realm 时，DELETE 仍按 DELETE 判定。
3. 跨 realm Headers 完整进入 `InterceptedRequest.headers`。
4. 判定读取 body 后，原 Request 的 `bodyUsed` 仍为 `false`，原 fetch 可继续消费它。
5. `npm run verify` 全部通过。
