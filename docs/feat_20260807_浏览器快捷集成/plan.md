# 浏览器快捷集成实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `@wandkit/browser` 的一调用浏览器集成，并以安全、可清理的方式组合 Runtime、页面 executor、聊天 UI 与请求治理。

**Architecture:** `mountWandkit()` 在宿主提供的 `LlmClient` 外组装页面模块和五个通用原语，使用 Web Components 渲染会话，用遮罩进行请求归属，用 interceptor 与显式 request tracker 形成确认和等待闭环。所有全局 patch 都由返回对象的幂等 `destroy()` 逆序清理。

**Tech Stack:** TypeScript、Vitest、jsdom、tsup、Web Components、npm workspaces。

---

### Task 1: 显式启动请求跟踪器

**Files:**
- Modify: `packages/executor/src/routeWatcher.spec.ts`
- Modify: `packages/executor/src/routeWatcher.ts`
- Modify: `packages/executor/src/index.ts`

- [ ] **Step 1: 写失败测试**

在 `routeWatcher.spec.ts` 增加用例：先调用 `startRequestTracking()`，再发起受控 Fetch，之后调用 `waitForDomStable()`；静默期过去但请求未完成时不得 resolve，请求完成后必须 resolve。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- packages/executor/src/routeWatcher.spec.ts`

Expected: FAIL，提示 `startRequestTracking` 尚未导出或定义。

- [ ] **Step 3: 最小实现**

在 `routeWatcher.ts` 导出：

```ts
export function startRequestTracking(): () => void {
  return acquireRequestTracker().release
}
```

并从 `packages/executor/src/index.ts` 导出。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- packages/executor/src/routeWatcher.spec.ts`

Expected: PASS。

### Task 2: 聊天面板提供停止操作

**Files:**
- Modify: `packages/chat/src/panel.spec.ts`
- Modify: `packages/chat/src/panel.ts`
- Modify: `packages/chat/README.md`

- [ ] **Step 1: 写失败测试**

覆盖：`busy` 状态下发送按钮显示“停止”并派发 `stop`；`awaiting_confirmation` 状态下按钮禁用且不派发；回到 `idle` 后恢复发送。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- packages/chat/src/panel.spec.ts`

Expected: FAIL，busy 状态下按钮仍禁用且文本为“发送”。

- [ ] **Step 3: 最小实现**

让发送按钮根据状态执行：

```ts
if (this.current.status === 'busy') {
  this.dispatchEvent(new CustomEvent('stop', { bubbles: true, composed: true }))
  return
}
this.send()
```

`busy` 时按钮可用且文本为“停止”；`awaiting_confirmation` 时禁用。

- [ ] **Step 4: 更新 README 并验证**

Run: `npm test -- packages/chat/src/panel.spec.ts`

Expected: PASS。

### Task 3: 搭建 `@wandkit/browser` 包

**Files:**
- Create: `packages/browser/package.json`
- Create: `packages/browser/tsconfig.json`
- Create: `packages/browser/tsup.config.ts`
- Create: `packages/browser/src/index.ts`
- Modify: `vitest.config.ts`

- [ ] **Step 1: 新建包清单和构建配置**

包名为 `@wandkit/browser`，输出 ESM、CJS 和声明文件；运行时依赖 `wandkit`、`@wandkit/executor`、`@wandkit/chat`、`@wandkit/ui`、`@wandkit/interceptor`。

- [ ] **Step 2: 更新测试源码别名和 jsdom 路由**

让浏览器包测试直接解析 workspace 源码，并为 `packages/browser/**` 使用 jsdom。

- [ ] **Step 3: 验证空包类型检查和构建**

Run: `npm run typecheck --workspace @wandkit/browser && npm run build --workspace @wandkit/browser`

Expected: PASS。

### Task 4: `mountWandkit()` 基础挂载与消息闭环

**Files:**
- Create: `packages/browser/src/mountWandkit.spec.ts`
- Create: `packages/browser/src/mountWandkit.ts`
- Modify: `packages/browser/src/index.ts`

- [ ] **Step 1: 写失败测试**

测试 `mountWandkit()`：挂载 `wandkit-dock` 与 `wandkit-chat`、设置 heading、通过 `controls.send()` 调用宿主 LLM、最终回答进入 ChatSession。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- packages/browser/src/mountWandkit.spec.ts`

Expected: FAIL，`mountWandkit` 尚未定义。

- [ ] **Step 3: 实现最小 Runtime 与 UI 组装**

创建 page module、PageController、page tools、registry、ActionRouter、ChatSession、bridge、dock 和 panel；返回 runtime/session/controls/destroy。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- packages/browser/src/mountWandkit.spec.ts`

Expected: PASS。

### Task 5: 工具历史与停止/清空接线

**Files:**
- Modify: `packages/browser/src/mountWandkit.spec.ts`
- Modify: `packages/browser/src/mountWandkit.ts`

- [ ] **Step 1: 写失败测试**

覆盖 page tool 调用后的历史必须包含匹配的 `assistant.tool_calls` 和 `tool.tool_call_id`；面板 `stop` 事件调用 Runtime stop；`new-chat` 调用 `runtime.clear()` 并清空会话。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- packages/browser/src/mountWandkit.spec.ts`

Expected: FAIL，assistant 事件尚未补充 tool calls 或 UI 事件未接线。

- [ ] **Step 3: 最小实现并重跑**

Runtime assistant 事件原样转发给 chat bridge，由核心携带规范化后的 `toolCalls`；监听 panel 的 `stop`、`new-chat`。

Expected: PASS。

### Task 6: interceptor、遮罩和请求等待闭环

**Files:**
- Modify: `packages/browser/src/mountWandkit.spec.ts`
- Modify: `packages/browser/src/mountWandkit.ts`

- [ ] **Step 1: 写失败测试**

构造页面按钮触发 POST Fetch：Agent 点击后出现确认卡；拒绝时底层 Fetch 不调用，工具结果带 `cancelled: true`，遮罩最终解除。另测动作后的 LLM POST 在 attribution grace window 中由精确 `llmRequest` matcher 放行，同时模型等待期间的其他业务写请求仍被拒绝。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- packages/browser/src/mountWandkit.spec.ts`

Expected: FAIL，尚未安装 interceptor/tracker 或取消结果未反馈 Runtime。

- [ ] **Step 3: 最小实现**

固定顺序：安装 interceptor → `startRequestTracking()` 并保存租约释放函数；动作工具用 mask 包裹；确认 handler 更新 session 状态并记录拒绝；LLM 代理请求通过精确 matcher 放行。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- packages/browser/src/mountWandkit.spec.ts`

Expected: PASS。

### Task 7: 幂等销毁与全局 API 还原

**Files:**
- Modify: `packages/browser/src/mountWandkit.spec.ts`
- Modify: `packages/browser/src/mountWandkit.ts`

- [ ] **Step 1: 写失败测试**

记录 mount 前的 Fetch、XHR send、history pushState；连续调用两次 `destroy()` 后必须恢复原引用，UI 与遮罩均移除。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- packages/browser/src/mountWandkit.spec.ts`

Expected: FAIL，destroy 尚未完整逆序清理。

- [ ] **Step 3: 最小实现并重跑**

销毁顺序：stop Runtime → dispose controls/subscription/controller → disarm mask → 释放自身 tracker 租约 → uninstall interceptor → remove dock。

Expected: PASS。

### Task 8: 文档与完整验证

**Files:**
- Modify: `README.md`
- Create: `packages/browser/README.md`
- Create: `docs/feat_20260807_浏览器快捷集成/test-results.md`
- Create: `docs/feat_20260807_浏览器快捷集成/review.md`

- [ ] **Step 1: 写接入文档**

记录安装、`mountWandkit()` 示例、安全默认值、生命周期和 `npm link` 本地接入方式。

- [ ] **Step 2: 运行包级验证**

Run: `npm test -- packages/browser/src packages/executor/src/routeWatcher.spec.ts packages/chat/src/panel.spec.ts`

Expected: PASS。

- [ ] **Step 3: 运行全仓验证**

Run: `npm run verify`

Expected: 退出码 0，测试、类型检查和全部 workspace 构建通过。

- [ ] **Step 4: 自审**

检查公共 API、全局 patch 顺序、拒绝路径、destroy 幂等、文档示例和 `git diff --check`，将结果写入 `test-results.md` 与 `review.md`。
