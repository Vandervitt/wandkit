# 请求 URL 绝对化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 保证 Fetch、XHR、Beacon 交给策略层的请求 URL 一律为基于当前文档解析的绝对 URL，修复完整 origin 危险规则被相对请求绕过的问题。

**Architecture:** 在拦截器通道边界增加一个私有 URL 解析函数，所有非表单通道生成 `InterceptedRequest` 时复用它。网络调用继续透传原始参数，绝对化只作用于策略、披露和 trace 的纯数据快照。

**Tech Stack:** TypeScript、Vitest、jsdom、tsup

---

### Task 1: 用回归测试证明完整 URL 规则会漏掉相对请求

**Files:**
- Modify: `packages/interceptor/src/interceptor.spec.ts`
- Modify: `packages/interceptor/src/channels.spec.ts`

- [x] **Step 1: 写 Fetch 危险 GET 红测**

在 Fetch 确认路径加入用例，使用 `${location.origin}/api/export-all` 作为危险规则，调用
`fetch('/api/export-all')`，确认回调拒绝。断言请求抛出 `RequestDeniedError`、风险为
`destructive`、快照 URL 为绝对地址且原始 fetch 未被调用。

- [x] **Step 2: 写 XHR 危险 GET 红测**

在 XHR 用例中使用相同完整 URL 危险规则和拒绝回调，调用
`request.open('GET', '/api/export-all')` 后发送。断言确认收到绝对 URL 且底层 send 未执行。

- [x] **Step 3: 写 Beacon 完整 URL allow 红测**

为 Beacon 配置 `${location.origin}/api/metrics` 放行规则，调用相对 URL。断言返回 `true`、
底层收到的仍是原相对 URL，证明只规范化策略快照而不改原生参数。

- [x] **Step 4: 运行目标测试并确认按预期失败**

Run:

```bash
npx vitest run packages/interceptor/src/interceptor.spec.ts packages/interceptor/src/channels.spec.ts
```

Expected: 三个新增用例失败；Fetch/XHR 未进入确认，Beacon 返回 `false`。

### Task 2: 在请求快照入口统一绝对化 URL

**Files:**
- Modify: `packages/interceptor/src/interceptor.ts`

- [x] **Step 1: 增加私有解析函数**

```ts
function resolveRequestUrl(
  view: Window & typeof globalThis,
  value: string | URL
): string {
  return new view.URL(String(value), view.document.baseURI).href
}
```

- [x] **Step 2: Fetch 解析接收当前 Window 并绝对化**

将 `toInterceptedRequest(args, id)` 改为 `toInterceptedRequest(view, args, id)`，并把
`request?.url ?? String(input)` 交给 `resolveRequestUrl`。

- [x] **Step 3: XHR 与 Beacon 快照绝对化**

XHR 在 `open()` 记录状态时解析 URL；Beacon 在构造 `InterceptedRequest` 时解析 URL。
调用原始 API 时继续使用 `args` 或原 `url` 参数。

- [x] **Step 4: 运行目标测试并确认转绿**

Run:

```bash
npx vitest run packages/interceptor/src/interceptor.spec.ts packages/interceptor/src/channels.spec.ts
```

Expected: 两个测试文件全部通过。

### Task 3: 完成验证、复审和交付记录

**Files:**
- Create: `docs/fix_20260801_请求URL绝对化/test-results.md`
- Create: `docs/fix_20260801_请求URL绝对化/review.md`

- [x] **Step 1: 运行 interceptor 包相关测试**

```bash
npx vitest run packages/interceptor/src
```

Expected: interceptor 全部测试通过。

- [x] **Step 2: 运行完整验证**

```bash
npm run verify
git diff --check
```

Expected: 全仓测试、类型检查、构建通过，diff 无空白错误。

- [x] **Step 3: 记录测试与复审结论**

`test-results.md` 记录红绿证据、目标测试和完整验证；`review.md` 核对策略顺序、原生参数
透传、公开 API、跨通道一致性和改动范围。

- [ ] **Step 4: 提交并创建独立 PR**

提交信息使用 `fix:` 中文 Conventional Commit；首次推送严格使用：

```bash
git push -u origin fix_20260801_请求URL绝对化:fix_20260801_请求URL绝对化
```

创建一个只包含本修复的 PR，目标分支为 `main`，不删除分支。
