# @wandkit/interceptor

请求层的兜底治理。核心包治理**已声明**的工具，本包治理**一切走网络的写**——包括从未
被声明成工具的那些。

两者是纵深关系，不是替代关系。

## 为什么需要它

核心包的强制力建立在「写操作必须声明成 `defineWriteTool`」之上。但这条前提有两个
天然缺口：

- **宿主自有代码**的写操作从来不经过它
- **`@wandkit/executor` 的 DOM 原语**让 Agent 能做没声明过的事，那些事的风险
  无法在调用前预判

本包把闸门下沉到请求层：不管写操作是怎么来的，发出去之前都要过一遍。

## 默认拒绝，名单只表达例外

```ts
import {
  createInterceptor,
  createMaskAttribution,
  createAuthorizationScope
} from '@wandkit/interceptor'

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
  // form 不在默认通道中；需要治理原生表单时必须显式开启。
  channels: ['fetch', 'xhr', 'beacon', 'form'],
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
import { runAuthorized } from '@wandkit/interceptor'

await runAuthorized({ scope, token: confirmationId }, async () => {
  await api.deleteCustomer(id)   // 窗口内不再问人
})
```

`end` 一定在 `finally` 里。`execute` 抛异常却没关窗口，后续所有 Agent 请求都会被
无条件放行，**而且不会有任何报错提示闸门已经失效了**。

## 四条通道

| 通道 | 处理 | 代价 |
|---|---|---|
| `fetch` | 判定后再调原始实现 | 无 |
| `XMLHttpRequest` | `open` 记录、`send` 内部延迟发送 | **破坏同步时序** |
| `sendBeacon` | 无法挂起，需确认时拒发 | 改变宿主既有行为 |
| `<form>` | 显式开启后暂停原生 submit；直接 `form.submit()` 内部延迟 | **破坏直接 submit 的同步发送时序** |

`form` 刻意不加入默认通道。原生表单与宿主页面的事件、校验和导航逻辑耦合更深，接入方
必须通过 `channels` 明确选择；只写 `channels: ['form']` 也可以单独治理表单。

### 原生表单通道

显式开启后覆盖三种入口：用户点击或 Enter 产生的原生 submit、
`form.requestSubmit(submitter)`，以及不会触发 submit 事件的直接 `form.submit()`。

- 宿主监听器已经 `preventDefault()` 的 SPA submit 不进入 form 闸门。它后续发出的
  Fetch/XHR 请求仍由对应网络通道治理，不会重复确认。
- 批准后调用当前 `HTMLFormElement.prototype.submit` 重放，不再次派发 submit 事件，
  因此宿主 submit 监听器只执行一次；批准等待期间后安装的外部 submit wrapper 仍会参与。
- `form.submit()` 仍同步返回 `undefined`，但真正提交会延迟到异步判定完成之后；拒绝、
  确认异常或快照失效都表现为不提交。
- 初始批准绑定 action、method、enctype、target、accept-charset、submitter 和有序字段快照。
  等待期间任一配置、字符串字段或文件元数据变化，旧 continuation 都会被丢弃；页面需要
  重新发起提交，不会拿旧批准发送新内容。
- submitter 的 `formaction`、`formmethod`、`formenctype`、`formtarget` 和提交字段会进入
  请求投影，并在最终重放期间临时恢复。image submitter 的 `x/y` 字段同样保留。
- 多个 interceptor 实例按后安装到先安装的顺序治理，即 `B → A → browser`。已卸载且
  尚未开始判定的层会被跳过；某层在自己的异步判定期间卸载时，旧提交会被丢弃；全部
  捕获层都已失活时也不会自动放行。
- `method=dialog` 不属于网络请求，保持浏览器原行为，不进入闸门。
- iframe 中的表单属于另一个 Window realm，需要针对该 Window 单独传入 `view` 并安装。

监听器安装在 Window 冒泡末端。常见框架在 form、应用 root 或 document 上接管 submit，
会先执行并通过 `defaultPrevented` 被识别；但在 interceptor **之后**注册的 Window 级
submit 监听器运行得更晚，本库无法预知它是否还会接管该事件。

浏览器在构造 `new FormData(form, submitter)` 时会触发 `formdata`。初始快照、批准前复核、
submitter 字段差异计算和最终原生提交都可能再次运行 FormData 算法，因此 `formdata`
监听器可能执行多次。处理器必须幂等；计费、埋点或其他不可重复副作用不能直接放在
`formdata` 监听器中。

### 已知限制

**XHR 的同步时序**：`send()` 必须同步返回，而判定是异步的，因此真正的发送被推迟。
依赖「`send` 返回即已发出」的宿主代码会看到时序变化。

另一处不对称：fetch 被拒时抛 `RequestDeniedError`；XHR 的 `send()` 没有可以拒绝的
返回值，因此请求不会交给原生 `send()`，并显式派发 `abort` 与 `loadend`。宿主应通过
`onabort` 或 `loadend` 结束等待并清理 loading 状态。

**`sendBeacon` 无法挂起**：它设计上发生在 unload 期、同步返回 boolean，等不了异步
确认。默认拒发并通过 `onUnholdableRequest` 让接入方知情。

**原生表单的 MutationObserver 可见性**：重放会在同步 `try/finally` 内临时写入有效提交
属性并添加 submitter hidden input，随后立即恢复；MutationObserver 仍可能观察到这些
短暂变化。

**未覆盖**：WebSocket / SSE。

## 接现成的确认卡片

```ts
import { createConfirmCardHandler } from '@wandkit/interceptor/confirm-ui'

const confirm = createConfirmCardHandler({ host: document.body, mask })
```

单独子入口，因为它 import 了 `@wandkit/ui`，而那个包在模块顶层就
`extends HTMLElement`。从主入口导出会让任何一次 import 都要求 DOM——**拦截器要能在
没有界面的场景下单独使用**。

## 审计闭环

```ts
import { createTraceRecorder } from '@wandkit/interceptor'

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
