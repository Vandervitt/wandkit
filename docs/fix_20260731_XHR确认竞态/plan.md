# XHR 确认竞态 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让等待确认期间被重新 `open()` 的旧 XHR 发送失效，禁止旧批准发送新配置。

**Architecture:** 将 `open()` 写入 WeakMap 的状态对象同时作为 XHR 生命周期令牌。
`send()` 捕获该对象，异步确认落地后用对象身份确认实例仍处于同一生命周期，再决定是否
调用原始 `send()`。

**Tech Stack:** TypeScript、XMLHttpRequest、Promise、WeakMap、Vitest、jsdom、tsup

---

### Task 1: 重新 open 竞态回归测试

**Files:**
- Modify: `packages/interceptor/src/channels.spec.ts`

- [ ] **Step 1: 写入失败测试**

在 `describe('XMLHttpRequest')` 中加入延迟首次确认的用例：

```ts
it('等待确认期间重新 open 会使旧发送失效', async () => {
  let approveOld!: (allowed: boolean) => void
  const confirm = vi.fn()
    .mockImplementationOnce(() => new Promise<boolean>(resolve => { approveOld = resolve }))
    .mockResolvedValue(true)
  setup({ confirm })
  const request = new XMLHttpRequest()
  request.open('DELETE', '/api/users/u_1')
  request.send('old-body')
  await new Promise(resolve => setTimeout(resolve, 0))

  expect(confirm.mock.calls[0][0].request).toMatchObject({
    method: 'DELETE',
    url: '/api/users/u_1',
    body: 'old-body'
  })

  request.open('POST', '/api/transfers')
  approveOld(true)
  await new Promise(resolve => setTimeout(resolve, 0))

  expect(sent).toHaveLength(0)

  request.send('new-body')
  await new Promise(resolve => setTimeout(resolve, 0))

  expect(confirm.mock.calls[1][0].request).toMatchObject({
    method: 'POST',
    url: '/api/transfers',
    body: 'new-body'
  })
  expect(sent).toEqual([{ channel: 'xhr', method: 'POST', url: '/api/transfers' }])
})
```

- [ ] **Step 2: 写入同参数重新 open 的失败测试**

对象身份而不是 method/URL 值决定生命周期；加入相同参数重新初始化的用例：

```ts
it('即使参数相同，重新 open 也会使旧发送失效', async () => {
  let approveOld!: (allowed: boolean) => void
  setup({
    confirm: vi.fn(() => new Promise<boolean>(resolve => { approveOld = resolve }))
  })
  const request = new XMLHttpRequest()
  request.open('POST', '/api/actions')
  request.send('old-body')
  await new Promise(resolve => setTimeout(resolve, 0))

  request.open('POST', '/api/actions')
  approveOld(true)
  await new Promise(resolve => setTimeout(resolve, 0))

  expect(sent).toHaveLength(0)
})
```

- [ ] **Step 3: 运行测试确认旧实现失败**

Run:

```bash
npx vitest run packages/interceptor/src/channels.spec.ts
```

Expected: FAIL，两个用例在 `approveOld(true)` 后均已出现发送，证明旧批准没有绑定原
`open()` 生命周期。

### Task 2: 用 open 状态身份使旧 continuation 失效

**Files:**
- Modify: `packages/interceptor/src/interceptor.ts:290-308`

- [ ] **Step 1: 保留 send 时的状态对象引用**

把缺省对象只用于请求投影，单独保留 WeakMap 中的真实引用：

```ts
const state = xhrState.get(this)
const request: InterceptedRequest = {
  id: nextId(),
  method: state?.method ?? 'GET',
  url: state?.url ?? '',
  headers: {},
  body: parseBody(body as BodyInit | null | undefined),
  channel: 'xhr',
  timestamp: Date.now()
}
```

- [ ] **Step 2: 批准后校验生命周期未变化**

```ts
void gate(request).then(allowed => {
  if (allowed && xhrState.get(this) === state) {
    originalSend.call(this, body ?? null)
  }
})
```

- [ ] **Step 3: 运行目标测试确认转绿**

Run:

```bash
npx vitest run packages/interceptor/src/channels.spec.ts
```

Expected: PASS，13 个测试全部通过。

- [ ] **Step 4: 运行 interceptor 包类型检查**

Run:

```bash
npm run typecheck --workspace @toolairlock/interceptor
```

Expected: 退出码 0。

### Task 3: 完整验证与审查记录

**Files:**
- Create: `docs/fix_20260731_XHR确认竞态/test-results.md`
- Create: `docs/fix_20260731_XHR确认竞态/review.md`

- [ ] **Step 1: 运行完整门槛**

Run:

```bash
npm run verify
```

Expected: 所有测试、workspace 类型检查和构建通过。

- [ ] **Step 2: 执行发布前检查**

Run:

```bash
git diff --check
```

Expected: 无输出，退出码 0。

- [ ] **Step 3: 写入真实测试与自审结果**

`test-results.md` 记录基线、红灯、绿灯、完整测试数量和命令退出码；`review.md` 核对旧
continuation 失效、新请求独立确认、同参数重新 open、原 send 参数透传、无公开 API 变化。

### Task 4: 提交、推送与 PR

- [ ] **Step 1: 提交方案文档**

```bash
git add -- 'docs/fix_20260731_XHR确认竞态/design.md' \
  'docs/fix_20260731_XHR确认竞态/plan.md'
git commit -m 'fix: 记录 XHR 确认竞态方案'
```

- [ ] **Step 2: 提交实现与验证记录**

```bash
git add -- packages/interceptor/src/interceptor.ts \
  packages/interceptor/src/channels.spec.ts \
  'docs/fix_20260731_XHR确认竞态/test-results.md' \
  'docs/fix_20260731_XHR确认竞态/review.md'
git commit -m 'fix: 使重新打开的 XHR 旧发送失效'
```

- [ ] **Step 3: 首次推送同名分支**

```bash
git push -u origin fix_20260731_XHR确认竞态:fix_20260731_XHR确认竞态
```

- [ ] **Step 4: 创建独立 PR**

以 `main` 为目标创建 PR，正文包含竞态时序、对象身份方案、TDD 红绿证据、完整验证结果和
独立审查结论；不自动合并。
