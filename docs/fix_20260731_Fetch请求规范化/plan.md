# Fetch 请求规范化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 fetch 拦截器对 Request 自带 body 和跨 realm Request 做一致、从严且不消费原请求的规范化。

**Architecture:** 保持原始 fetch 调用完全透传，只在调用闸门前生成纯数据投影。Request 与 Headers 通过稳定能力识别，不使用跨 realm 不可靠的 `instanceof`；Request body 只从 clone 读取。

**Tech Stack:** TypeScript、Fetch API、Vitest、jsdom、tsup

---

### Task 1: Request 自带 body 回归测试

**Files:**
- Modify: `packages/interceptor/src/interceptor.spec.ts`

- [ ] **Step 1: 写入失败测试**

新增测试：POST Request body 为 `{ force: true }`，危险规则按 body 命中，同时存在相同 URL
的放行规则；确认回调拒绝时请求必须被拦下，并收到 `destructive` 和真实 body。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run packages/interceptor/src/interceptor.spec.ts`

Expected: FAIL，表现为请求被直接发送或确认回调未被调用。

### Task 2: 跨 realm Request 回归测试

**Files:**
- Modify: `packages/interceptor/src/interceptor.spec.ts`

- [ ] **Step 1: 写入失败测试**

先创建真实 DELETE Request，再临时替换当前全局 Request 构造器模拟另一 realm。断言确认回调
仍收到 DELETE、真实 URL 与 header，而不是 `GET [object Request]`。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run packages/interceptor/src/interceptor.spec.ts`

Expected: FAIL，表现为安全方法直接放行。

### Task 3: 最小实现

**Files:**
- Modify: `packages/interceptor/src/interceptor.ts`

- [ ] **Step 1: 增加 Request 能力识别**

实现内部 `isRequestLike()`，检查 `url`、`method`、`headers` 和 `clone`，移除全局
`Request instanceof` 依赖。

- [ ] **Step 2: 从 clone 读取 Request body**

当 `init.body` 为 nullish 且 Request 自带 body 时，调用 `request.clone().text()`，再复用
`parseBody()`；这与 Fetch 沿用输入 Request body 的语义一致。读取异常直接向上传播，禁止
信息不完整时继续放行。

- [ ] **Step 3: 兼容跨 realm Headers**

`normalizeHeaders()` 优先检测标准 `forEach` 能力，再处理数组与普通对象。

- [ ] **Step 4: 运行目标测试确认转绿**

Run: `npx vitest run packages/interceptor/src/interceptor.spec.ts`

Expected: PASS。

### Task 4: 原请求不被消费

**Files:**
- Modify: `packages/interceptor/src/interceptor.spec.ts`

- [ ] **Step 1: 增加保护测试**

原始 fetch 桩读取真正收到的 Request body；断言闸门判定前后 `bodyUsed` 未被提前置为 true，
且原始 fetch 能读取完整 JSON。

- [ ] **Step 2: 运行目标测试**

Run: `npx vitest run packages/interceptor/src/interceptor.spec.ts`

Expected: PASS。

### Task 5: 完整验证与记录

**Files:**
- Create: `docs/fix_20260731_Fetch请求规范化/test-results.md`
- Create: `docs/fix_20260731_Fetch请求规范化/review.md`

- [ ] **Step 1: 运行完整门槛**

Run: `npm run verify`

Expected: 全部测试、类型检查和构建通过。

- [ ] **Step 2: 执行发布前检查**

Run: `git diff --check`

Expected: 无输出，退出码 0。

- [ ] **Step 3: 记录测试与自审结论**

写入真实命令、退出码、测试数量，并核对：原参数透传、body 未被消费、跨 realm 语义、无公开
API 变化。

### Task 6: 提交、推送与 PR

- [ ] **Step 1: 提交**

在确认分支仍为 `fix_20260731_Fetch请求规范化` 后提交：

```bash
git commit -m "fix: 规范化 Fetch Request 请求信息"
```

- [ ] **Step 2: 首次推送**

```bash
git push -u origin fix_20260731_Fetch请求规范化:fix_20260731_Fetch请求规范化
```

- [ ] **Step 3: 创建 PR**

目标分支为 `main`，PR 正文包含根因、红绿证据、兼容性和完整验证结果；不自动合并。
