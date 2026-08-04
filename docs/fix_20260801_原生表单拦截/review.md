# 原生表单拦截复审记录

分支：`fix_20260801_原生表单拦截`

基线：`main` @ `80dbf41`

## 结论

第二轮全 diff 复审未发现需要阻止提交的高置信度问题。实现范围与已批准设计一致，没有
改变公开类型、默认通道或 Fetch/XHR/Beacon 的既有契约。

## 改动与状态

| 文件 | 状态 | 复审结论 |
|---|---|---|
| `packages/interceptor/src/patchLifecycle.ts` | 新增 | 私有生命周期模块；增加 `form-submit`，未从公开入口导出 |
| `packages/interceptor/src/form.ts` | 新增 | 快照、投影、事件协调、直接 submit patch 与安全重放职责集中 |
| `packages/interceptor/src/interceptor.ts` | 修改 | 显式安装 form；所有通道事务式安装并逆序回滚 |
| `packages/interceptor/src/form.spec.ts` | 新增 | 40 个行为、竞态、错误和生命周期用例 |
| `packages/interceptor/README.md` | 修改 | 显式开启、时序、formdata 幂等和监听器边界已记录 |

## 规格与契约核对

| 核对项 | 结果 | 证据 |
|---|---|---|
| form 仍需显式开启 | 通过 | `DEFAULT_CHANNELS` 保持 `fetch/xhr/beacon`；有默认不拦截用例 |
| 原生 submit / requestSubmit | 通过 | Window 冒泡监听统一捕获 submit 事件；requestSubmit 用例通过 |
| 直接 `form.submit()` | 通过 | prototype wrapper 同步返回，异步 gate 后调用 previous |
| SPA `preventDefault()` 跳过 | 通过 | 创建共享上下文前检查 `defaultPrevented`；宿主监听器只执行一次 |
| 不重复派发 submit | 通过 | 重放调用当前 prototype submit，未调用 `requestSubmit()` |
| GET/POST 投影 | 通过 | GET 替换 query 保留 fragment；POST 保留 action query 与 enctype |
| 重复字段/文件/formdata | 通过 | 重复字段保留数组；文件仅纯元数据；动态 FormData 字段进入快照 |
| submitter override/字段/image | 通过 | 有效配置进入快照；有序差值转临时 hidden input |
| 等待期间变化失效 | 通过 | 字段、action、method、enctype、target、acceptCharset、文件和 submitter 均覆盖 |
| `method=dialog` | 通过 | 事件不阻止，直接 submit 同步透传 |
| 多实例顺序 | 通过 | 共享 Symbol 注册表和事件上下文实现 `B → A → browser` |
| 任意卸载/旧引用/重装 | 通过 | 生命周期元数据跳过连续失活层，旧卸载闭包不拆新安装 |
| 外部 wrapper | 通过 | 重放读取当前 prototype；卸载不覆盖后安装 wrapper |
| 安装失败回滚 | 通过 | listener/注册表失败均逆序 restore，`installed === false` |
| 原错误行为 | 通过 | 底层或外部 submit 抛错在 finally 清理后异步重新暴露 |
| 无公开 API 破坏 | 通过 | `src/index.ts` 和 `src/types.ts` 相对 main 无 diff |

## 安全与数据边界

- 策略、confirm、describe 和 onVerdict 继续复用现有 gate，没有复制或绕开权限判定顺序。
- 策略与披露只拿纯数据快照，不持有 form、submitter、File 或 Blob 句柄。
- 文件不读取内容，只记录 name/type/size/lastModified。
- POST body 通过 `Map` + `Object.fromEntries` 构造，`__proto__` 保持普通自有属性。
- 快照或注册表读取失败均从严阻止；用户拒绝、confirm 异常和快照失效均不提交。
- 临时 action/method/enctype/target 和 hidden input 均在同步 `finally` 中恢复。

## 生命周期与事务复审

- patch 元数据沿用 `Symbol.for('@wandkit/interceptor.patch')`，支持多个 bundle 副本识别。
- form 共享注册表使用 `Symbol.for('@wandkit/interceptor.form-registry')`；不兼容值和抛错
  getter 不被覆盖。
- 事件上下文只协调同一个 SubmitEvent；microtask 中按 layer 逆序 gate。
- 当前 gate 等待期间卸载会使旧 continuation 失效；全部 layer 失活时不自动放行。
- install 的任一步失败都逆序回滚已收集 restore，保留最初安装错误。

## 已知限制与剩余风险

- `formdata` 监听器会因快照和复核执行多次，必须幂等；README 已明确。
- 直接 `form.submit()` 的真实提交从同步变为异步延迟。
- interceptor 之后注册的 Window submit 监听器运行过晚，无法提前识别为 SPA 接管者。
- MutationObserver 可能看到重放期间短暂的属性和 hidden input 变化。
- 本机缺少 Browser 插件和 Playwright，未执行真实浏览器冒烟；jsdom 单元测试、类型检查和
  全仓构建已覆盖实现契约，但真实导航仍需在有浏览器环境的 CI 或人工回归中补验。

## 范围检查

`git diff --name-status main...HEAD` 只包含本修复的设计/计划、interceptor 生产代码、测试和
README；没有数据库、依赖、构建配置、公开入口或其他 package 的无关改动。
