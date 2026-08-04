# 原生表单拦截设计

分支：`fix_20260801_原生表单拦截`
基线：`main` @ `80dbf41`

## 背景与问题

`RequestChannel` 已公开 `'form'`，`InterceptorOptions.channels` 的注释也声明 form 可显式
开启，但 `createInterceptor()` 当前只安装 Fetch、XHR 和 Beacon patch：

```ts
createInterceptor({
  // ...
  channels: ['form']
}).install()
```

以上配置会成功返回，却不监听表单事件、不 patch `HTMLFormElement.prototype.submit`，也不
产生 verdict 或确认。调用方会误以为原生表单已受请求闸门保护，实际提交可完全绕过。

SPA 表单通常在 submit 处理器中 `preventDefault()` 后通过 Fetch/XHR 发请求，现有网络
通道已经能够治理。真正缺失的是浏览器原生导航式提交，以及不会触发 submit 事件的直接
`form.submit()`。

## 已确认的产品边界

1. 只治理将触发浏览器原生提交的表单。
2. 宿主已经 `preventDefault()` 的 SPA submit 事件不重复确认，继续由 Fetch/XHR 治理。
3. 覆盖用户点击或 Enter、`form.requestSubmit(submitter)` 和直接 `form.submit()`。
4. 等待确认期间表单内容或提交配置变化时，旧批准必须失效，不提交变化后的内容。
5. 多个 interceptor 实例仍按后安装到先安装的顺序依次治理。
6. 接受快照与重放可能多次触发 `formdata` 事件的限制，并在 README 明确要求处理器幂等。

## 目标

- 显式启用 `'form'` 后，所有浏览器原生表单提交进入现有策略、确认和 trace 链路。
- SPA 自管表单不增加第二次确认，也不阻止其现有 submit 处理器。
- 原始 submit 事件中的宿主监听器只执行一次，不通过再次 `requestSubmit()` 重放事件。
- request 快照准确反映有效 action、method、enctype、submitter 和表单数据。
- 用户批准的快照与最终原生提交保持绑定；任何变化都使旧 continuation 失效。
- `form.submit()` 保持同步返回 `undefined`，但真实提交延迟到异步判定完成。
- 支持多实例、任意卸载顺序、热更新和后安装的外部 submit wrapper。
- form 注册表或监听安装失败时，整个 interceptor 安装必须回滚，不留下其他通道的半安装
  状态。
- 不改变公开 API、默认通道或既有 Fetch/XHR/Beacon 行为。

## 非目标

- 不治理已由宿主 `preventDefault()` 的 SPA 表单业务逻辑。
- 不拦截 iframe 内另一个 Window 的表单；该 realm 需要单独注入 `view` 并安装 interceptor。
- 不保证 interceptor 之后注册的 window 级 submit 处理器可被识别为 SPA 接管者。
- 不消除异步确认对 `form.submit()` 同步时序的改变。
- 不处理 WebSocket、SSE、导航链接或自定义非表单提交协议。
- 不读取文件内容，也不把 File/Blob 句柄交给策略或披露回调。

## 方案比较

### 方案一：末端事件协调 + 原生 submit 重放（采用）

在 Window 冒泡末端观察 submit。宿主已阻止的事件直接跳过；原生事件由共享上下文暂停，
收集所有激活 form 层并按逆安装顺序执行 gate。批准后调用当前 prototype submit，并通过
短暂重放标记让本库 wrapper 透明透传。

该方案不重新派发 submit 事件，宿主 submit 监听器只执行一次，同时保留外部 wrapper。

### 方案二：Capture 拦截后调用 requestSubmit 重放

浏览器会自然应用 submitter 属性和约束校验，但会再次触发所有宿主 submit 监听器，可能
造成重复校验、埋点、状态修改或网络请求。

### 方案三：只 patch submit/requestSubmit

实现较小，但用户点击按钮和按 Enter 触发的原生提交不保证调用 JavaScript 可见的方法，
会留下直接绕过入口。

## 组件与文件边界

### `patchLifecycle.ts`

把 PR #4 已验证的私有 patch 元数据从 `interceptor.ts` 抽到内部模块，供 Fetch、XHR、
Beacon 和 Form 共用。`PatchKind` 增加 `'form-submit'`。

该模块不从 `packages/interceptor/src/index.ts` 导出，不构成公开 API。

### `form.ts`

负责以下独立职责：

- 计算有效表单配置与不可变快照。
- 把快照投影为 `InterceptedRequest`。
- 协调原生 submit 事件中的多个 interceptor 层。
- patch 直接 `form.submit()`。
- 安全重放原生提交并恢复临时属性。

### `interceptor.ts`

保留策略、gate 和通道安装编排。`channels.has('form')` 时调用 `patchForm(view, gate, nextId)`。
通道安装改为事务式：任一步抛错都按逆序执行已经收集的 restore、重置 `installed`，再把
原错误抛给调用方。

## 共享表单注册表

同一 Window 可能加载多个 interceptor 实例或多个 bundle 副本。form 事件不能让每个实例
独立暂停和重放，否则会产生重复原生提交。因此在 `view` 上通过
`Symbol.for('@wandkit/interceptor.form-registry')` 保存结构校验后的内部注册表：

```ts
interface FormRegistry {
  source: '@wandkit/interceptor'
  eventContexts: WeakMap<SubmitEvent, FormEventContext>
  replayingForms: WeakSet<HTMLFormElement>
}
```

- `eventContexts` 让不同实例识别同一个被本库暂停的 submit 事件。
- `replayingForms` 标记已经完成所有 gate 的原生重放；submit wrapper 看到标记后只透传。
- 注册表异常、结构冲突或属性读取抛错时从严阻止本次 form 安装，不覆盖外部值。

## 原生 submit 事件流程

每个 form patch 层在 `window` 冒泡阶段注册一个监听器：

```text
target/form/root/document listeners
              │
              ▼
window submit listener A（先安装）
              │ 创建共享上下文、preventDefault、加入 A
              ▼
window submit listener B（后安装）
              │ 识别本库上下文、加入 B
              ▼
事件传播结束后的 microtask
              │
              ├─ gate B
              ├─ 重新校验快照
              ├─ gate A
              ├─ 最终重新校验
              └─ 原生重放
```

第一个 form 层处理事件时：

1. 确认 target 是当前 view 的 `HTMLFormElement`。
2. 若 `event.defaultPrevented` 已为 true，说明宿主已接管，直接返回且不创建上下文。
3. 若有效 method 为 `dialog`，保持原行为，不创建上下文。
4. 构建初始快照；构建失败则 `preventDefault()` 并阻止提交。
5. `preventDefault()`，创建共享上下文，加入当前层并排队一个 microtask。

后续 form 层若看到共享上下文，只把自己的 gate、nextId 和生命周期加入 layers。microtask
按 layers 的逆序执行，保持 `B → A → browser`。每一层开始前都检查仍为 active；全部层
都已卸载时丢弃旧提交，不自动放行。

宿主若在 interceptor 之后才注册 window 级 submit 监听器，本库无法知道它稍后是否会
接管提交。常见框架监听器位于 form、应用 root 或 document，会先于 window 阶段运行，
可被 `defaultPrevented` 正确识别。此限制必须写入 README。

## 直接 `form.submit()` 流程

`HTMLFormElement.prototype.submit` 不产生 submit 事件，因此每个 form 层安装一个普通
wrapper：

```text
form.submit()
   │
   ▼
wrapper B：快照 B → gate B → 校验 B
   │
   ▼
wrapper A：快照 A → gate A → 校验 A
   │
   ▼
browser / external submit
```

- wrapper 同步返回 `undefined`，异步链内部决定是否真正提交。
- 失活 wrapper 直接调用 previous。
- `method=dialog` 或 `replayingForms.has(form)` 时直接透传，不重复治理。
- 每层批准后再次生成本层快照；不一致则停止，不调用 previous。
- restore 沿用 patch 生命周期：只在 prototype 当前仍是自己的 wrapper 时写回，并跳过
  同类型的连续失活层。

`requestSubmit()` 不 patch。它先执行浏览器约束校验，再产生 submit 事件，由事件协调器
统一处理。

## 表单快照

```ts
interface FormSubmissionSnapshot {
  form: HTMLFormElement
  submitter: HTMLElement | null
  action: string
  method: 'GET' | 'POST' | 'DIALOG'
  enctype: string
  target: string
  acceptCharset: string
  entries: readonly FormEntrySnapshot[]
  submitterEntries: readonly FormStringEntry[]
}
```

有效配置按浏览器优先级计算：submitter 显式声明的
`formaction/formmethod/formenctype/formtarget` 优先，否则使用 form 对应属性。action 始终
解析为绝对 URL。

数据通过 `new view.FormData(form, submitter)` 构建，保留浏览器的 successful controls、
重复字段、外部 form-associated controls、image 坐标和 `formdata` 监听器修改。

entry 快照为纯数据：

```ts
type FormEntryValueSnapshot =
  | { kind: 'string', value: string }
  | {
      kind: 'file'
      name: string
      type: string
      size: number
      lastModified: number
    }
```

文件只记录元数据。快照比较按字段顺序、名称、类型和值逐项比较；同时比较 form、
submitter、action、method、enctype、target 和 acceptCharset。

submitterEntries 由 `FormData(form, submitter)` 与 `FormData(form)` 做有序多重集差得到。
submitter 只能贡献字符串字段，因此可在重放时用临时 hidden input 表达；image submitter
自然产生 `name.x/name.y` 或 `x/y`。

## InterceptedRequest 投影

### GET

- 用有序 entries 构造 `URLSearchParams`。
- 字符串使用原值，文件使用文件名。
- 替换 action URL 的 query，保留 fragment。
- `body` 为 `undefined`，headers 为空。

### POST

- URL 使用有效 action，不改写其既有 query。
- `headers['content-type']` 使用有效 enctype；multipart 不伪造 boundary。
- body 转为纯数据对象；单值为一个值，重复字段为数组，文件为上述元数据对象。

所有请求固定 `channel: 'form'`，使用各 interceptor 自己的 `nextId()` 和现有 gate，因此
策略顺序、授权窗口、confirm、describe 和 onVerdict 无需复制。

## 竞态与快照失效

初始事件快照只是用户批准对象。以下任一变化都会使旧 continuation 失效：

- form 或 submitter 身份变化。
- action、method、enctype、target、acceptCharset 变化。
- 字段增删、顺序、名称或字符串值变化。
- 文件名、类型、大小或 lastModified 变化。
- submitter 额外字段变化。
- 对应 patch 层在等待期间卸载。

事件链在每个异步 gate 前后重新校验；直接 submit wrapper 在自己的 gate 批准后重新校验。
失效后不提交当前内容，也不自动弹出新确认；页面必须重新发起提交。

## 安全重放

事件链全部批准后：

1. 保存 form 的 `action/method/enctype/target` 属性是否存在及原始文本值。
2. 临时写入快照中的有效配置，确保 submitter override 与批准内容一致。
3. 为 `submitterEntries` 逐项追加临时 hidden input。
4. 把 form 加入 `replayingForms`。
5. 调用当前 `HTMLFormElement.prototype.submit`，保留批准期间新安装的外部 wrapper。
6. 在 `finally` 中移除 hidden input、恢复原属性并清除 replay 标记。

本库各 submit wrapper 看到 replay 标记后直接调用 previous，因此不会重新 gate；外部
wrapper 仍按其自身逻辑执行。

原始 submit 事件已通过 `requestSubmit()` 或用户交互完成浏览器约束校验。直接
`form.submit()` 按原生语义继续跳过校验，本库不额外调用 `reportValidity()`。

## `formdata` 事件限制

浏览器在 `new FormData(form, submitter)` 时会触发 `formdata`。初始快照、批准前重新校验、
submitter 差异计算和最终原生提交都可能触发该事件，因此宿主 formdata 处理器会执行多次。

仍选择浏览器 FormData 算法，原因是手工模拟会漏掉：

- formdata 监听器动态追加或修改的数据。
- form-associated controls、disabled fieldset、image 坐标和文件字段等 successful controls
  规则。

README 必须明确：启用 form 通道时，formdata 处理器应保持幂等，不得把计费、埋点或其他
不可重复副作用直接放在其中。

## 错误处理

- 快照或注册表构建失败：从严阻止本次原生提交。
- form 注册表创建、prototype 写入或事件监听安装失败：回滚本次 install 已经完成的所有
  通道 patch，`installed` 恢复为 false，并原样抛出安装错误。
- evaluate/confirm/describe：沿用现有 gate 的从严或降级语义。
- 用户拒绝或 confirm 抛错：不提交。
- 临时属性或 hidden input 恢复：始终放在 `finally`。
- 原生或外部 submit 抛错：恢复完成后保留原错误行为，不把失败误报为成功。
- `form.submit()` 没有 Promise 返回给调用方，被拒和快照失效与 XHR 一样表现为不发送。

## 生命周期与卸载

每个 form patch 层用同一个 `PatchLifecycle` 管理 window listener 和 submit wrapper：

- uninstall 先置 `active = false`。
- 移除该层自己的 window listener。
- prototype 当前仍是自己的 wrapper 时，跳过连续失活 form-submit wrapper 后恢复。
- 待确认上下文在每次 await 后检查 active；卸载层不再 gate。
- 所有捕获层均失活时丢弃旧事件，不恢复原生提交。
- 重复卸载与跨重装旧卸载闭包继续由现有 install 周期幂等逻辑保证。

## 涉及文件

| 文件 | 操作 | 说明 |
|---|---|---|
| `packages/interceptor/src/patchLifecycle.ts` | 新增 | 承载已有 patch 元数据与安全恢复逻辑，增加 form-submit 类型 |
| `packages/interceptor/src/form.ts` | 新增 | 表单快照、事件协调、submit patch 与安全重放 |
| `packages/interceptor/src/interceptor.ts` | 修改 | 引入 lifecycle 模块、事务式安装并安装 form 通道 |
| `packages/interceptor/src/form.spec.ts` | 新增 | 表单行为、竞态、多实例和外部边界测试 |
| `packages/interceptor/README.md` | 修改 | form 使用方式、时序代价和已知限制 |
| `docs/fix_20260801_原生表单拦截/plan.md` | 新增 | TDD 与交付步骤 |
| `docs/fix_20260801_原生表单拦截/test-results.md` | 新增 | 红绿、浏览器冒烟和完整验证结果 |
| `docs/fix_20260801_原生表单拦截/review.md` | 新增 | 规格、契约与复审结论 |

## 测试策略

所有 bugfix 用例先在旧实现或阶段性实现上看到预期失败：

1. 显式 form 通道能拦截用户/Enter 和 requestSubmit 产生的原生 submit。
2. 直接 form.submit 同步返回 undefined，批准后才调用安装前实现。
3. SPA 先 preventDefault 时不确认、不重放，宿主处理器只执行一次。
4. 原生 submit 的宿主处理器只执行一次，不重新派发事件。
5. GET 查询、POST enctype、submitter override、普通 submitter 字段和 image 坐标准确。
6. 重复字段、文件元数据和 formdata 动态字段进入快照。
7. 拒绝、confirm 异常、快照构建异常和 method=dialog 行为正确。
8. 等待期间字段、文件元数据或提交配置变化使旧 continuation 失效。
9. 多实例按 B → A 判定，任意卸载顺序、待确认卸载和旧引用均正确。
10. 后安装的外部 submit wrapper 不被卸载覆盖，重放仍经过它。
11. form 安装失败时，先安装的 Fetch/XHR/Beacon 全部回滚且 `installed === false`。
12. Fetch/XHR/Beacon 生命周期抽取后全部现有测试不回归。

分层执行：

```bash
npx vitest run packages/interceptor/src/form.spec.ts
npx vitest run packages/interceptor/src
npm run typecheck --workspace @wandkit/interceptor
npm run verify
```

该功能改变真实浏览器的原生表单行为。若本机已有可用 Playwright 浏览器，则使用临时
development 页面执行原生 GET/POST、requestSubmit 和 SPA preventDefault 冒烟；产物放在
`.playwright/fix_20260801_原生表单拦截-20260801/`，不散落到项目根目录、不入 Git。若环境
不可用，真实记录跳过原因，不声称已执行。

## 风险与回退

- formdata 处理器会多次执行，必须幂等。
- `form.submit()` 的真实提交从同步变为异步延迟，依赖即时导航的代码会看到时序变化。
- interceptor 之后注册的 window submit 监听器可能无法被识别为 SPA 接管者。
- native submit 重放会临时修改 form 属性并添加 hidden input，但全部在同步调用的 finally
  中恢复；MutationObserver 仍可能观察到这些短暂变化。
- 回退只需撤销本 PR；默认 channels 不含 form，未显式启用的接入方不受影响。

## 验收标准

1. `channels: ['form']` 不再静默失效。
2. 原生 submit、requestSubmit 和直接 submit 三种入口均受治理。
3. SPA preventDefault 表单不重复确认。
4. 用户批准内容与最终提交快照一致，变化后旧提交不执行。
5. submitter 配置和字段被准确投影并在重放时保留。
6. 多实例、卸载、外部 wrapper 和热更新语义与其他通道一致。
7. 任一通道安装失败后无半安装状态残留。
8. 无公开 API 破坏，form 仍为显式开启。
9. interceptor 全量测试、`npm run verify` 和独立复审通过；浏览器冒烟真实记录。
