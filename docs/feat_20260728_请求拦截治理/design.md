# 请求拦截治理 —— 设计

> 状态：待评审
> 分支：`feat_20260728_请求拦截治理`

## 1. 背景

当前 toolairlock 的能力边界等于**声明过的工具集合**：没写 `defineWriteTool`，Agent 就做不了那件事。这带来两个后果：

- **接入成本高。** 每一项能力都要写 schema、风险等级、`prepare`/`execute`。
- **覆盖必然有缺口。** 宿主自有代码、以及未来任何非声明式执行路径产生的写操作，完全在治理之外。

同时，风险分类当前**只能**来自工具契约的 `risk` 字段。这让「能力声明」和「风险分类」这两件本来独立的事被绑死——而它们不必绑死。

本设计拆开这两个角色：

| 角色 | 现在 | 改造后 |
|---|---|---|
| 能力声明 | 必须逐个声明 | **可选**。自由执行器提供未声明的能力 |
| 风险分类 | 来自 `risk` 字段 | 来自**请求层判定策略**（默认拒绝 + 名单 A/B） |

目标：**广度与安全不再互斥**。Agent 能做没声明过的事，而这些事照样过闸门。

## 2. 定位变更（需要明确承认）

README 现有的非目标声明将被推翻：

```diff
- 不解析 DOM、不模拟点击——那是执行引擎的事
+ 通过 ExecutorPort 接入执行引擎（可用 page-agent，也可自建）
```

项目从「纯治理层」扩展为「治理层 + 可插拔执行层」。**治理仍是核心**：执行器是可选依赖，不接执行器时行为与现在完全一致。

## 3. 总体架构

```
                    ┌─────────────────────────────────┐
   用户输入 ──→     │        AgentRuntime (core)       │
                    └────────┬───────────────┬─────────┘
                             │               │
              路径 A：声明式工具         路径 B：自由执行器
                             │               │
                    prepare → 确认 → execute │  自由 GUI/API 动作
                             │               │
                             ↓               ↓
                    ┌────────────────────────────────┐
                    │   @toolairlock/interceptor      │
                    │   fetch / XHR / sendBeacon      │
                    │   默认拒绝 + 名单 A/B            │
                    └────────────┬───────────────────┘
                                 ↓
                          确认卡片（复用 ui 包）
                                 ↓
                          放行 / 拒绝
```

两条路径**强度不同，必须在文档里显式区分**：

| | 路径 A（声明式工具） | 路径 B（自由执行 + 拦截） |
|---|---|---|
| 强制力 | 类型层面（`execute` 拿不到 `TInput`） | 运行时 |
| 确认时机 | 动作**之前** | 动作**中途**（发请求那一刻） |
| 确认前重跑比对（TOCTOU） | 有 | 无 |
| 披露内容 | 业务语义（「用户：张三」） | 原始请求（可选 `describe()` 富化） |
| 覆盖面 | 仅已声明工具 | 一切走网络的写 |

定位是**纵深防御**：A 精确制导，B 兜底渔网。B 的存在让 A 的覆盖缺口不再致命。

## 4. 自由执行器

### 4.1 端口而非绑定

不直接依赖 page-agent，沿用本项目既有的窄端口风格（`RouterPort` / `PageAdapter` / `LlmClient`）：

```ts
interface ExecutorPort {
  execute(instruction: string, signal?: AbortSignal): Promise<ExecutorResult>
}
```

page-agent 作为**其中一种实现**，通过适配器接入；宿主也可自建。

### 4.2 以工具形态并入运行时（关键决策）

自由执行器**不新开一条并行通道**，而是包装成一个内置工具：

```ts
const operatePage = defineExecutorTool({
  moduleId: 'system', name: 'operate', version: 1,
  description: '当没有更精确的工具可用时，直接操作当前页面完成用户请求',
  executor: pageAgentAdapter
})
```

这样做的收益：轮次上限、工具预算、权限过滤、trace、`maxToolCalls` 全部自动复用，运行时不必新增一套并行的生命周期管理。

**它的 `risk` 无法预先判定**——调用之前不知道它会点什么。因此它不走 `prepare`，其副作用完全交由拦截器逐个请求把关。这正是本设计成立的前提：风险分类从「工具声明时」推迟到了「请求发出时」。

### 4.3 权限

执行器工具本身**必须**可以被权限过滤掉。没有 `system:operate` 权限的用户，模型根本看不到它——最小权限原则在这一层仍然成立。

### 4.4 阻塞项：`ToolRisk` 放不下执行器工具（需拍板）

编写类型骨架时暴露出来的问题：现有四档风险 `read | write | destructive | navigation` **都要求风险在注册时已知**，而执行器工具的风险要到请求发出那一刻才判定。

硬塞进 `read` 会造成静默的洞：拦截器一旦没装，它就是个完全不受管的万能写入口。

建议核心包新增一档：

```ts
type ToolRisk = 'read' | 'write' | 'destructive' | 'navigation' | 'delegated'
```

`delegated` 语义为「副作用由下游拦截治理」，并由 `ToolRegistry` 强制两条：

1. `delegated` 工具**不得**声明 `prepare`——它没有可展示的确认内容；
2. 注册 `delegated` 工具时**必须**已启用拦截治理，否则**启动即抛错**。

第 2 条是关键：它把「忘了装拦截器」从一个运行期的静默缺口，变成一个部署前的硬失败。这与本包既有的风格一致——契约违规在应用启动前就炸，而不是等到生产环境表现为一次错误的写入。

**这是核心契约变更，影响 `ToolDefinition` 联合类型、注册表校验与 README 的核心设计章节，需单独确认后再动。**

## 5. 拦截器

### 5.1 判定策略

```ts
type Verdict =
  | { action: 'allow' }
  | { action: 'confirm', risk: 'write' | 'destructive' }
  | { action: 'deny', reason: string }
```

判定顺序（**顺序本身是安全语义，不可调整**）：

| 序 | 条件 | 结果 | 理由 |
|---|---|---|---|
| 1 | 非 Agent 发起 | `allow` | 用户自己的操作不归闸门管 |
| 2 | 处于已授权窗口 | `allow` | 路径 A 已确认过，见 §7 |
| 3 | 安全方法（GET/HEAD/OPTIONS/TRACE） | `allow` | 无副作用 |
| 4 | 命中**名单 B（danger）** | `confirm` as `destructive` | **必须先于名单 A** |
| 5 | 命中**名单 A（allow）** | `allow` | 已知安全的写 |
| 6 | 兜底 | `confirm` as `write` | **默认拒绝** |

**第 4 步先于第 5 步是本设计最关键的一条。** 名单 A 往往写成宽泛通配（`POST /api/*/search`），若让它先匹配，一条粗糙的放行规则就可能把高危动作一并放过。危险优先于放行，是安全策略的通例。

**第 6 步是与「黑名单」的根本区别。** 新上线的 `/api/v2/purge` 没人加进名单，仍然会被拦下要求确认——漏配的代价是多一次确认，而不是静默失去防护。

### 5.2 规则与匹配

```ts
interface RequestMatcher {
  method?: string | string[]
  /** glob（支持 * 与 :param）或 RegExp */
  url?: string | RegExp
  /** 进一步按请求体判定，如仅当 { force: true } 才算高危 */
  when?(request: InterceptedRequest): boolean
}

interface RequestRule {
  id: string
  match: RequestMatcher
  /** 可选：把原始请求翻译成业务语义，见 §6 */
  describe?(request: InterceptedRequest): Promise<RequestDisclosure>
}
```

### 5.3 拦截通道

| 通道 | 可否挂起 | 处理 |
|---|---|---|
| `fetch` | 可 | 等判定后再调原始实现 |
| `XMLHttpRequest` | 可（`send` 内部延迟透传） | 同上，但破坏同步时序，需记录为已知限制 |
| `navigator.sendBeacon` | **不可**（设计为 unload 期发送，同步返回 boolean） | 命中需确认时**直接拒发并返回 false**，并告警 |
| `<form>` submit | 可（capture 阶段 `preventDefault`） | 确认后再程序化提交 |
| `<a href>` 导航 | 不适用 | 属导航非写入，不拦 |
| WebSocket / SSE | 本期不覆盖 | 记入已知缺口 |

`sendBeacon` 是真实缺口：无法挂起，只能二选一（放行或拒发）。默认拒发更符合本包的立场，但会改变宿主行为，需在文档中显著提示。

### 5.4 生命周期

```ts
interface Interceptor {
  install(): () => void   // 返回 uninstall，可重复调用且幂等
}
```

必须可卸载（测试、SPA 热更新），且对未被拦截的请求保持原始行为与原始 `this` 绑定。

## 6. 归属判定

拦截器必须分清 Agent 发起与用户发起，否则用户手动点删除也会弹确认，产品不可用。

```ts
interface AttributionPort {
  isAgentActive(): boolean
}
```

默认实现绑定 `@toolairlock/ui` 的 `InteractionMask`：遮罩武装期间即 Agent 动作窗口。这是**排除法**——窗口内用户无法操作，故请求必然来自 Agent，从而绕开了「跨异步边界传递发起方上下文」这个浏览器里没有可靠解法的问题。

**宽限期**：Agent 动作可能触发防抖保存等延迟请求，在遮罩解除后才发出。设 `graceMs`（默认 500ms），解除后该窗口内仍按 Agent 归属。取值需权衡：过长会把用户的操作误判成 Agent 的。

## 7. 双路径去重（必做项，非优化）

路径 A 的工具在用户确认后执行 `execute`，其内部发出的请求会被拦截器再次捕获。若不处理，**每给一个动作写声明式工具，反而多挨一次确认**——等于惩罚正确做法。

方案：**已授权窗口**。

```ts
interface AuthorizationScope {
  begin(token: string): void
  end(token: string): void
}
```

`ActionRouter` 在执行已确认的写工具前后调用。窗口内的 Agent 请求视为已获批准，直接放行，但**仍写入 trace**。

**已知取舍**：窗口是粗粒度的——该工具在窗口内发出的任何请求都会被放行。这在路径 A 的信任模型下可接受（工具是声明过、评审过的代码，其行为本就被假定与声明一致），但必须在文档中写明：**它不防御「声明式工具本身行为不符合声明」这种情况**。

## 8. 披露

路径 B 天然只有原始请求。`PreparedAction.rawRequest`（已实现）正是为此准备的字段，直接复用。

```ts
interface RequestDisclosure {
  title: string
  rows: ConfirmationRow[]
  impact?: string
}
```

不提供 `describe()` 时，卡片展示 `method + url + body`。这**确实是相对路径 A 的能力下降**——给人看 `DELETE /api/users/u_1`，他得自己知道 u_1 是张三。

缓解：按规则可选注册 `describe()`。它是**可选增强**而非前置门槛，因此不会把「逐个声明」重新变成必需品。

## 9. 安全性分析

### 9.1 相对现状增强

- 宿主自有代码、未声明能力产生的写入，**首次**进入治理范围。
- 漏配规则的后果从「静默无防护」变为「多一次确认」。

### 9.2 相对现状削弱

| 削弱项 | 说明 |
|---|---|
| 确认时机后移 | 从「动作前」变成「请求发出那一刻」。用户拒绝时，页面可能已被填了一半，需要执行器负责回退或明确终止 |
| 无 TOCTOU 重跑比对 | 请求体已冻结，但它要作用的数据仍可能在确认期间被改动，且拦截器无法重跑 `prepare` 去比对 |
| 披露质量 | 见 §8 |

### 9.3 新增攻击面

- **Prompt injection 面显著扩大。** 自由执行器读取任意 DOM，比带 schema 的声明式工具暴露得多。现有缓解（页面上下文以 user 角色注入并标注不可信）在这里**强度不足**——注入内容可以直接是「点击那个删除按钮」这类可执行指令。这是本设计最需要正视的风险，拦截器的默认拒绝正是针对它的最后一道防线。
- **客户端副作用不经网络**（清 localStorage、纯前端状态变更后批量保存），拦截器看不见。

## 10. 不做什么

- 不做后端侧鉴权。后端始终是每次调用的最终裁决方，本设计只解决「浏览器内、Agent 发起」这一段。
- 不保证拦截无法被绕过。宿主页面自身的代码若直接持有原始 `fetch` 引用，可绕开 patch。本设计防的是 Agent 的误操作，不是恶意宿主。
- 本期不覆盖 WebSocket / SSE / Service Worker。
