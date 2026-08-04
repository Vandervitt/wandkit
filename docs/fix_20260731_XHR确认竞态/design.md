# XHR 确认竞态修复设计

分支：`fix_20260731_XHR确认竞态`
基线：`main` @ `2fde954`

## 背景与问题

`@wandkit/interceptor` 会在 `XMLHttpRequest.send()` 时生成不可变的
`InterceptedRequest`，等待异步确认后再调用原始 `send()`。但真正发送时使用的仍是原
XHR 实例，而该实例在等待期间可以再次调用 `open()` 改写 method 与 URL。

当前时序如下：

```text
open(DELETE, /api/users/u_1)  → state A
send(oldBody)                 → 等待确认 A
open(POST, /api/transfers)    → XHR 实例切换到 state B
批准确认 A                    → originalSend(oldBody)
                               实际发送到 state B
```

这使“批准的请求”和“实际发送的请求”失去绑定：用户看见并批准删除用户，网络层却可能
收到另一个 URL、方法与旧 body 的组合。

## 根因

- 策略与确认使用的是 `send()` 时生成的请求快照。
- 批准后的 continuation 只保存 XHR 实例与 body，没有保存并校验对应的 `open()` 状态。
- `open()` 会替换 `xhrState` 中的对象，但当前代码没有利用这个变化使旧 continuation
  失效。
- `install()` 返回的卸载闭包只读取共享的 `installed` 标记，没有记录自己是否已执行；旧
  卸载闭包在重新安装后再次调用，会把新安装误判为自己的安装周期并恢复旧原型。

## 目标

- 等待确认期间再次 `open()` 时，先前 `send()` 的 continuation 必须失效。
- 等待确认期间卸载 interceptor 时，该安装周期的所有 continuation 必须失效。
- 每个 `install()` 返回的卸载闭包必须按安装周期幂等，旧闭包不得拆除后续重装。
- 即使新旧 `open()` 的 method 与 URL 相同，也应按重新初始化处理并使旧发送失效。
- 新配置只有再次调用 `send()` 并完成自己的判定后才能真正发送。
- 未发生重新 `open()` 时，现有允许、拒绝、body 解析和异步时序保持不变。
- 不修改公开 API，不合并其他 XHR 生命周期问题。

## 非目标

- 不改变 XHR `send()` 同步返回、实际网络发送延后的既有限制。
- 不处理同一 `open()` 状态下重复调用 `send()` 的原生 send-flag 语义。
- 不处理等待确认期间调用 `abort()` 的生命周期语义。
- 不修改 fetch、sendBeacon、规则顺序或确认 UI。

## 推荐方案

`patchedOpen()` 每次都会向 `xhrState` 写入一个新的 `XhrCallState` 对象。`patchedSend()`
保存当时的对象引用；确认结束后，只有 WeakMap 中的当前引用仍与快照相同才调用原始
`send()`。同时每次 `patchXhr()` 安装维护一个 `active` 标记，卸载时先置为 `false`，
使恢复原型后的旧确认无法继续发送：

```ts
const state = xhrState.get(this)

void gate(request).then(allowed => {
  if (allowed && active && xhrState.get(this) === state) {
    originalSend.call(this, body ?? null)
  }
})
```

对象身份而不是 method/URL 值用于比较，因为重新 `open()` 本身就是一次 XHR
重新初始化；即使参数相同，旧 `send()` 也不应在新的生命周期中复活。

每次成功安装还会为返回的卸载闭包创建独立 `cleaned` 标记。闭包首次执行时先将其置为
`true`，后续重复调用直接返回；这样共享的 `installed` 只表示当前是否已安装，而不会让
旧闭包跨安装周期操作新 patch：

```ts
let cleaned = false

return () => {
  if (cleaned) return
  cleaned = true
  if (!installed) return
  installed = false
  restores.forEach(restore => restore())
}
```

## 数据流

```text
open A ──→ xhrState = stateA
                │
send A ──→ capture stateA ──→ gate(requestA)
                │                    │
open B ──→ xhrState = stateB         │ approved
                                     ▼
                         current stateB !== stateA
                                     │
                                     └─ 丢弃旧 continuation，不发送

send B ──→ capture stateB ──→ gate(requestB) ──→ stateB === stateB ──→ send

uninstall ──→ active = false ──→ 旧 gate 即使批准也不发送

install 1 ──→ uninstall 1（cleaned = false）
                  │ 首次调用：cleaned = true，拆除 install 1
install 2 ──→ uninstall 2（独立 cleaned = false）
                  │
旧 uninstall 1 再调用：cleaned 已为 true，install 2 保持安装
```

## 涉及文件

| 文件 | 操作 | 说明 |
|---|---|---|
| `packages/interceptor/src/channels.spec.ts` | 修改 | 增加重新 open、卸载及跨重装卸载竞态测试 |
| `packages/interceptor/src/interceptor.ts` | 修改 | 校验 XHR open 状态身份，并保证卸载闭包按安装周期幂等 |
| `docs/fix_20260731_XHR确认竞态/plan.md` | 新增 | TDD 与交付步骤 |
| `docs/fix_20260731_XHR确认竞态/test-results.md` | 新增 | 记录红绿及完整验证结果 |
| `docs/fix_20260731_XHR确认竞态/review.md` | 新增 | 记录状态契约和独立审查结论 |

## 风险与回退

- 重新 `open()` 后旧发送将被静默丢弃，这与 XHR 重新初始化会终止旧请求的语义一致；
  当前 interceptor 本就无法为拒绝构造可靠的同步异常或原生网络事件。
- WeakMap 查询为常数时间，只在确认 Promise 落地时增加一次对象身份比较。
- 回退只需撤销本 PR；不涉及数据、配置或公开契约迁移。

## 验收标准

1. 旧请求等待确认时重新 `open()`，批准旧请求不会发送新配置。
2. 新配置再次 `send()` 后会生成独立确认，并在批准后只发送一次。
3. 确认回调看到的旧、新 method、URL 与 body 各自正确。
4. 等待确认期间卸载后，旧批准不会发送卸载期间的新配置。
5. 第一次安装的卸载闭包重复调用，不会拆除第二次安装或放行其待确认请求。
6. 现有 XHR、fetch、beacon 测试不回归。
7. `npm run verify` 全部通过。
