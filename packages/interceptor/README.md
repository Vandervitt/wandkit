# @toolairlock/interceptor

请求层的兜底治理。核心包治理**已声明**的工具，本包治理**一切走网络的写**——包括从未
被声明成工具的那些。

两者是纵深关系，不是替代关系。

## 为什么需要它

核心包的强制力建立在「写操作必须声明成 `defineWriteTool`」之上。但这条前提有两个
天然缺口：

- **宿主自有代码**的写操作从来不经过它
- **`@toolairlock/executor` 的 DOM 原语**让 Agent 能做没声明过的事，那些事的风险
  无法在调用前预判

本包把闸门下沉到请求层：不管写操作是怎么来的，发出去之前都要过一遍。

## 默认拒绝，名单只表达例外

```ts
import {
  createInterceptor,
  createMaskAttribution,
  createAuthorizationScope
} from '@toolairlock/interceptor'

const interceptor = createInterceptor({
  policy: {
    danger: [{
      id: 'delete-customer',
      match: { method: 'DELETE', url: '/api/customers/:id' },
      describe: async request => ({
        title: '确认删除客户',
        rows: [{ label: '目标', value: request.url.split('/').pop() }],
        impact: '删除后不可恢复'
      })
    }],
    allow: [{
      id: 'search',
      match: { method: 'POST', url: '/api/*/search' }   // 查询伪装成 POST
    }]
  },
  attribution: createMaskAttribution({ isMaskArmed: () => mask.armed }),
  authorization: scope,
  confirm: async ({ request, risk, disclosure }) => askUser(disclosure ?? request)
})

interceptor.install()
```

新上线的 `/api/v2/purge` 没人加进名单，**仍然会被拦下要求确认**。漏配的代价是多一次
确认，而不是静默失去防护——这是与黑名单方案的根本区别。

### 判定顺序不可调整

| 序 | 条件 | 结果 |
|---|---|---|
| 1 | 非 Agent 发起 | 放行 |
| 2 | 处于已授权窗口 | 放行 |
| 3 | 命中**危险名单** | 确认（`destructive`） |
| 4 | 安全方法（GET/HEAD/OPTIONS/TRACE） | 放行 |
| 5 | 命中**放行名单** | 放行 |
| 6 | 兜底 | 确认（`write`） |

两条关键：

- **第 3 步先于第 5 步**——放行名单常写成宽泛通配（`/api/*/search`），让它先命中，
  一条粗糙规则就能把高危动作一并放过。
- **第 3 步也先于第 4 步**——`GET /api/export-all-data` 没有副作用却会外泄数据。安全
  方法若先短路，这类请求永远无法被名单拦下。

## 归属判定：靠遮罩，不靠链路追踪

闸门必须分清「Agent 发的」和「用户自己点的」，否则用户手动删除也会弹确认，产品直接
不可用。

跨异步边界传递发起方上下文，在浏览器里没有可靠解法。改用**排除法**：

```ts
createMaskAttribution({ isMaskArmed: () => mask.armed, graceMs: 500 })
```

遮罩武装期间用户点不动页面，因此窗口内的请求必然来自 Agent。

`graceMs` 是必需的：Agent 的操作常触发防抖保存一类的延迟请求，它们在遮罩解除之后才
真正发出。默认 500ms——取大了会把用户紧接着的真实操作误判成 Agent 的。

## 已授权窗口：不重复确认

路径 A 的工具在用户确认后执行 `execute`，其内部发出的请求会被本包再次捕获。不处理的
话，**每给一个动作写声明式工具，反而多挨一次确认**——那等于惩罚正确做法。

```ts
import { runAuthorized } from '@toolairlock/interceptor'

await runAuthorized({ scope, token: confirmationId }, async () => {
  await api.deleteCustomer(id)   // 窗口内不再问人
})
```

`end` 一定在 `finally` 里。`execute` 抛异常却没关窗口，后续所有 Agent 请求都会被
无条件放行，**而且不会有任何报错提示闸门已经失效了**。

## 三条通道

| 通道 | 处理 | 代价 |
|---|---|---|
| `fetch` | 判定后再调原始实现 | 无 |
| `XMLHttpRequest` | `open` 记录、`send` 内部延迟发送 | **破坏同步时序** |
| `sendBeacon` | 无法挂起，需确认时拒发 | 改变宿主既有行为 |

### 已知限制

**XHR 的同步时序**：`send()` 必须同步返回，而判定是异步的，因此真正的发送被推迟。
依赖「`send` 返回即已发出」的宿主代码会看到时序变化。

另一处不对称：fetch 被拒时抛 `RequestDeniedError`，**XHR 被拒时什么也不做**——它没有
可以抛错的返回值，宿主的 `error` / `timeout` 处理都不会触发。

**`sendBeacon` 无法挂起**：它设计上发生在 unload 期、同步返回 boolean，等不了异步
确认。默认拒发并通过 `onUnholdableRequest` 让接入方知情。

**未覆盖**：`<form>` 提交（需显式开启且与宿主表单逻辑耦合较深）、WebSocket / SSE。

## 接现成的确认卡片

```ts
import { createConfirmCardHandler } from '@toolairlock/interceptor/confirm-ui'

const confirm = createConfirmCardHandler({ host: document.body, mask })
```

单独子入口，因为它 import 了 `@toolairlock/ui`，而那个包在模块顶层就
`extends HTMLElement`。从主入口导出会让任何一次 import 都要求 DOM——**拦截器要能在
没有界面的场景下单独使用**。

## 审计闭环

```ts
import { createTraceRecorder } from '@toolairlock/interceptor'

createInterceptor({
  // …
  onVerdict: createTraceRecorder({ traces, getRunId: () => runtime.snapshot().runId })
})
```

**放行也记录**——只记拦下的，等于把闸门最常走的那条路径变成盲区。

URL 的 query 一律剥掉，请求体完全不进轨迹：轨迹会落到本地存储，而 query 常带 token
与手机号。核心包连用户原话都只存长度，判定轨迹没有理由更宽松。

## 闸门自身出错时一律从严

三处都朝更安全的方向倒：

| 出错的地方 | 处置 |
|---|---|
| 归属判定 | 按「Agent 发起」——走完整闸门 |
| 策略求值 | 按「需要确认」 |
| `confirm` 回调 | 按「拒绝」 |

唯一例外是 `describe()` 抛错：只降级卡片质量，不连带拒掉请求——那会把一个可用的确认
流程变成死路。

## 非目标

- **不防恶意宿主**。页面自身的代码若直接持有原始 `fetch` 引用即可绕开。本包防的是
  Agent 的误操作。
- **不替代后端鉴权**。后端始终是每次调用的最终裁决方。

## 可运行样例

```bash
npm run example:interceptor
```

七个场景：用户操作放行、Agent 操作确认、已授权窗口、危险优先于放行、默认拒绝、
接真实确认卡片、审计闭环。
