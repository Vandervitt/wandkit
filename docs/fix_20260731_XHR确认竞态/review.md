# XHR 确认竞态自审

## Scope

| 文件 | 状态 | 审查结论 |
|---|---|---|
| `packages/interceptor/src/interceptor.ts` | 修改 | 仅增加 XHR open 状态身份校验 |
| `packages/interceptor/src/channels.spec.ts` | 修改 | 增加 2 个重新 open 竞态测试 |
| `docs/fix_20260731_XHR确认竞态/*` | 新增 | 设计、计划、测试和审查记录 |

未修改 fetch、beacon、规则求值、确认 UI、公开类型或包导出。

## 契约核对

| 验收项 | 证据 | 结论 |
|---|---|---|
| 不同配置重新 open 使旧发送失效 | 延迟旧确认，切到 POST 后批准旧 DELETE，网络记录保持空 | 通过 |
| 相同参数重新 open 仍视为新生命周期 | 同 method/URL 重开后批准旧请求，网络记录保持空 | 通过 |
| 新配置必须独立确认 | 新配置再次 send 后出现第二次 confirm，批准后只发送一次 | 通过 |
| 确认内容与各自请求一致 | 断言旧 DELETE/old-body 与新 POST/new-body 的请求快照 | 通过 |
| 无重新 open 时行为不变 | 原有允许、拒绝、body、异步时序测试全部通过 | 通过 |
| 无公开 API 变化 | 仅修改 `patchXhr()` 内部条件 | 通过 |

## 实现审查

- `patchedSend()` 捕获 WeakMap 中的真实状态对象引用，不再创建无法参与身份比较的缺省
  空对象；无 `open()` 时 `undefined === undefined`，保持既有兜底行为。
- 每次 `patchedOpen()` 都写入新对象，因此对象身份天然代表一次 XHR 重新初始化，不需要
  额外计数器，也不会因相同 method/URL 而误认为仍是旧生命周期。
- 只有 `allowed` 且当前状态对象仍等于发送时快照时才调用原始 `send()`；拒绝和失效都不会
  触发网络发送。
- 新请求仍使用调用方传给新 `send()` 的 body，原始 `send()` 的 `this` 与参数调用方式未改。
- 新增成本仅为确认 Promise 落地时的一次 WeakMap 查询和严格相等比较。

## Scope 控制

- 未改变 XHR 异步确认导致的 send 时序限制。
- 未处理重复 send、abort 等独立生命周期语义。
- 未夹带后续正则状态污染修复。

## 结论

实现与设计一致，竞态由结构性的生命周期令牌校验解决，而不是针对某个 URL 或方法打补丁。
