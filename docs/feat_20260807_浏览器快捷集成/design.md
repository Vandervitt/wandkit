# 浏览器快捷集成设计

## 目标

新增 `@wandkit/browser` 包，让宿主用一次 `mountWandkit()` 调用接入 Wandkit 页面 Agent，而不再手工组装 Runtime、DOM executor、聊天 Web Components、请求拦截器、交互遮罩和生命周期清理。

首个真实接入方是 Vue 2 的 `aicc-admin-front`，但本包保持框架无关，只依赖标准 DOM 和宿主提供的 `LlmClient`。

## 非目标

- 不在浏览器保存模型 API Key；模型请求仍由宿主后端代理。
- 不内置 AICC 路由、权限或接口放行规则。
- 不替代后端鉴权。
- 不把业务工具声明重新塞回快捷集成；首版使用 `@wandkit/executor` 的通用页面原语。
- 不支持同一 Window 内并行运行多个页面 Agent；首版按单实例顺序执行。

## 公共 API

```ts
import { mountWandkit } from '@wandkit/browser'

const app = mountWandkit({
  llm: {
    chat(messages, tools, signal) {
      return backend.chat({ messages, tools, signal })
    }
  },
  heading: 'Admin Copilot',
  getPermissions: () => store.getters.permissions,
  interception: {
    llmRequest: { method: 'POST', url: '/api/llm/chat' },
    policy: {
      allow: [/* 经核实的只读 POST */],
      danger: [/* 高危请求 */]
    }
  }
})

app.destroy()
```

`mountWandkit()` 返回：

```ts
interface MountedWandkit {
  runtime: AgentRuntime
  session: ChatSession
  controls: ChatControls
  destroy(): void
}
```

`destroy()` 幂等；负责停止活动 Run、解除遮罩、退订会话、停止请求跟踪、卸载 interceptor 并移除 UI。

## 组件边界

| 组件 | 职责 |
|---|---|
| `mountWandkit` | 公开入口、依赖组装、DOM 挂载与销毁 |
| `AgentRuntime` | 工具调度、历史、Deadline、结构化终态 |
| `PageController` + `createPageTools` | 页面读取、点击、输入、下拉选择和滚动 |
| `ChatSession` + `connectRuntime` | OpenAI 消息历史与 UI 状态投影 |
| `<wandkit-dock>` + `<wandkit-chat>` | 框架无关聊天界面 |
| `InteractionMask` | Agent 动作期间阻止用户并发操作，并提供请求归属依据 |
| interceptor | 对 Agent 真实发出的 Fetch/XHR/Beacon 做默认确认治理 |
| request tracker | 等待确认、网络结束和 DOM 稳定，避免动作提前返回 |

## 数据流

```text
用户输入
  → ChatSession / connectRuntime
  → AgentRuntime
  → 宿主 LlmClient（代理请求由精确 llmRequest matcher 放行）
  → 模型选择 page_* 原语
  → 武装 InteractionMask
  → PageController 操作 DOM
  → request tracker 捕获 Fetch/XHR
  → interceptor 判定
      ├─ allow：直接发送
      ├─ confirm：在聊天面板显示确认卡
      └─ deny/reject：请求不发送，XHR 触发 abort + loadend
  → 等待请求结束与 DOM 稳定
  → 页面最新快照回传模型
  → 最终回答进入 <wandkit-chat>
```

## 关键时序

### 请求跟踪安装顺序

必须先安装 interceptor，再显式启动 request tracker：

```text
browser API → request tracker → interceptor → native API
```

这样请求从页面动作发起时立即进入 pending；确认等待也属于请求在途时间。批准后直到真实响应 `loadend`/Promise settle 才归零，拒绝 XHR 则由 `abort + loadend` 结束等待。

为消除隐式调用，`@wandkit/executor` 新增 `startRequestTracking()`。它返回幂等释放函数并
使用引用计数；`waitForDomStable()` 也只持有一次临时租约。最后一个租约释放时才还原
Fetch/XHR，而且只在全局引用仍是自身 patch 时还原，避免覆盖后来安装的外层包装。

若宿主已经先持有 tracker，browser 安装 interceptor 后 tracker 会落在内层，无法统计
确认等待。首版不尝试重排未知全局 patch，而是检测到 tracker 不在最外层时拒绝 mount，
并回滚 controller、interceptor、controls 与 mask；宿主应释放旧 tracker 后再挂载。

### LLM 请求不重复确认

遮罩解除后的短暂 grace window 仍可能把下一轮 `/llm/chat` 判为 Agent 请求。快捷集成要求
宿主用 `interception.llmRequest` 提供精确 method + URL matcher，并把它合并为 allow 规则。
不能用 authorization scope 包裹整个异步 `llm.chat()`：模型等待期间到达的其他业务写请求
会共享同一个 Window 级授权状态并被误放行。

### Runtime 与 Chat 历史一致性

Runtime 的 assistant 事件直接携带规范化后的 `toolCalls`，包括由兼容 content 格式转换出的
调用；browser 不再从原始 LLM 回复缓存字段。`connectRuntime()` 在发送前标记 ChatSession
安全点，收到 cancelled 终态时整轮回滚，与 Runtime 的 ConversationStore 保持同一边界。

### Agent 动作与遮罩

- `page_read` 不武装遮罩。
- `click/input/select/scroll` 从动作开始到请求与 DOM 稳定结束始终武装遮罩。
- 确认卡位于 `wandkit-dock` 的最高层，遮罩无需撤除，用户不能趁确认期间修改底层页面。
- 若用户拒绝 interceptor 确认，本次工具结果带 `cancelled: true` 回喂模型，禁止把“按钮点击成功”误报成业务成功。

## 聊天 UI 行为

- `idle`：输入并发送。
- `busy`：发送按钮切换为“停止”，触发 `ChatControls.stop()`。
- `awaiting_confirmation`：输入和停止均锁定，只允许处理确认卡。
- “新建对话”调用 `runtime.clear()`，同时清理 Runtime 与 ChatSession 历史。
- 待确认或错误出现时强制展开 dock。

## 错误处理

| 场景 | 行为 |
|---|---|
| LLM 抛错 | Runtime 进入 failed，ChatSession 展示结构化错误 |
| interceptor 确认回调异常 | 从严拒绝；工具结果标记取消 |
| 用户拒绝 Fetch/XHR | 不发送请求；页面动作等待正常结束；模型收到取消结果 |
| XHR 被拒 | 显式派发 `abort`、`loadend`，Axios 和 tracker 都能收尾 |
| DOM 索引过期 | executor 返回 `retryable` 结果，模型重新读页面 |
| destroy 重复调用 | 第二次为空操作，不重复还原全局 patch |

## 文件改动

| 文件 | 操作 |
|---|---|
| `packages/browser/package.json` | 新建包清单 |
| `packages/browser/tsconfig.json` | 新建类型检查配置 |
| `packages/browser/tsup.config.ts` | 新建 ESM/CJS/d.ts 构建 |
| `packages/browser/src/index.ts` | 公共导出 |
| `packages/browser/src/mountWandkit.ts` | 快捷集成实现 |
| `packages/browser/src/mountWandkit.spec.ts` | 集成回归测试 |
| `packages/executor/src/routeWatcher.ts` | 新增带引用计数租约的 request tracker 启动 API |
| `packages/executor/src/routeWatcher.spec.ts` | 新增安装顺序测试 |
| `packages/executor/src/index.ts` | 导出新 API |
| `packages/executor/src/snapshot.ts` | 增加快照排除谓词，隔离 Wandkit 自身 UI |
| `packages/executor/src/snapshot.spec.ts` | 覆盖 Shadow DOM 子树排除 |
| `packages/chat/src/panel.ts` | busy 状态提供停止事件 |
| `packages/chat/src/panel.spec.ts` | 停止交互回归测试 |
| `packages/chat/src/session.ts` / `bridge.ts` | Chat 安全点与取消回滚 |
| `packages/core/src/runtime/agentRuntime.ts` | assistant 事件携带规范化 tool calls |
| `packages/chat/README.md` | 更新面板事件说明 |
| `vitest.config.ts` | 浏览器包使用 jsdom，并将 workspace 包解析到源码 |
| `README.md` | 增加快捷集成包说明 |

## 测试策略

1. `startRequestTracking()` 必须在请求发起前显式安装，并让 DOM 稳定等待真实请求结束。
2. 聊天面板 busy 状态必须提供停止操作，awaiting confirmation 状态不得误触停止。
3. `mountWandkit()` 必须挂载 dock/panel、传递 heading、发送消息并展示最终回答。
4. 工具调用历史必须保留合法的 `assistant.tool_calls → tool` 配对。
5. Agent 写请求必须展示确认卡；拒绝后请求不发送、遮罩解除、工具结果标记取消。
6. grace window 内只允许精确匹配的 LLM POST；模型等待期间的其他业务写请求仍被拒绝。
7. `destroy()` 必须幂等并还原 Fetch/XHR/history 包装。
8. 页面快照不得包含 Wandkit 自身 dock、panel、确认卡或 mask。
9. 销毁时当前及排队中的 interceptor 确认必须全部从严拒绝。
10. 多个 tracker 使用者分别释放租约；宿主预装 tracker 导致顺序错误时 browser 必须
    拒绝挂载并完整回滚。
11. 兼容 content 规范化出的 tool calls 必须进入 Chat 历史；工具执行中 stop 后整轮回滚。
12. 最终执行 `npm run verify`，覆盖全仓单测、类型检查和所有 workspace 构建。

## 风险与控制

- interceptor 和 tracker 都 patch 浏览器全局 API：通过固定安装顺序、租约引用计数、
  identity-aware 还原和幂等测试控制。
- 首版无法安全重排未知的预装 tracker：检测到错误层级时显式失败，不带着不完整的稳定
  等待继续运行。
- Web Components 使用 Shadow DOM：E2E 通过可访问名称与 Shadow DOM locator 验证。
- 默认对非安全 HTTP 方法要求确认；宿主只能用精确规则放行已核实的只读 POST。
- 首版不支持多实例，避免多个 Runtime 争用同一页面和重复 patch。
