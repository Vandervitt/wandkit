# 正则规则状态污染 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让带 `g`/`y` 标志的 URL 正则规则重复判定保持一致，并且不修改调用方的 `lastIndex`。

**Architecture:** 保持现有规则求值和 URL 目标选择不变，只在 RegExp 分支隔离匹配游标。
每次判定保存原 `lastIndex`、从 0 调用原对象的 `test()`，并在 `finally` 中恢复，从而同时
支持原生 `g`/`y` 与 RegExp 子类自定义 `exec()`。

**Tech Stack:** TypeScript、RegExp、Vitest、npm workspaces、tsup

---

### Task 1: 建立状态污染回归测试

**Files:**
- Modify: `packages/interceptor/src/policy.spec.ts:224-240`

- [ ] **Step 1: 增加危险规则重复判定测试**

在 `describe('matchesRequest')` 前新增：

```ts
describe('RegExp URL 规则的确定性', () => {
  it.each([
    ['g', /\/api\/users\//g],
    ['y', /^https:\/\/app\.example\.com\/api\/users/y]
  ])('带 %s 标志的危险规则重复判定不会间歇性降级', (_flag, pattern) => {
    const policy: InterceptionPolicy = {
      danger: [{ id: 'danger-users', match: { url: pattern }}]
    }

    const reasons = [evaluate(policy), evaluate(policy), evaluate(policy)]
      .map(result => result.reason)

    expect(reasons).toEqual(['danger_list', 'danger_list', 'danger_list'])
  })

  it.each([
    ['g', /\/api\/users\//g],
    ['y', /^https:\/\/app\.example\.com\/api\/users/y]
  ])('带 %s 标志的正则不会被一次判定修改 lastIndex', (_flag, pattern) => {
    pattern.lastIndex = 7

    expect(matchesRequest(request(), { url: pattern })).toBe(true)
    expect(pattern.lastIndex).toBe(7)
  })
})
```

- [ ] **Step 2: 运行目标测试确认红灯**

Run:

```bash
npx vitest run packages/interceptor/src/policy.spec.ts
```

Expected: FAIL，新增 4 个测试失败；重复判定结果为
`danger_list, default_deny, danger_list`；`g` 游标变为 34，`y` 从游标 7 开始无法命中。

### Task 2: 覆盖 RegExp 子类边界

**Files:**
- Modify: `packages/interceptor/src/policy.spec.ts:239-270`

- [ ] **Step 1: 增加可覆写 getter 与 exec 回归测试**

```ts
it('RegExp 子类覆写 global getter 时仍按内部 g 状态稳定判定', () => {
  class HiddenGlobalRegExp extends RegExp {
    override get global(): boolean {
      return false
    }
  }
  const pattern = new HiddenGlobalRegExp('/api/users/', 'g')
  const policy: InterceptionPolicy = {
    danger: [{ id: 'danger-users', match: { url: pattern }}]
  }

  const reasons = [evaluate(policy), evaluate(policy), evaluate(policy)]
    .map(result => result.reason)

  expect(reasons).toEqual(['danger_list', 'danger_list', 'danger_list'])
  expect(pattern.lastIndex).toBe(0)
})

it('保留 RegExp 子类自定义 exec 的匹配语义', () => {
  class NeverMatchRegExp extends RegExp {
    override exec(_value: string): RegExpExecArray | null {
      return null
    }
  }
  const pattern = new NeverMatchRegExp('/api/users/', 'g')

  expect(matchesRequest(request(), { url: pattern })).toBe(false)
  expect(pattern.lastIndex).toBe(0)
})
```

- [ ] **Step 2: 运行测试确认中间克隆方案失败**

Run:

```bash
npx vitest run packages/interceptor/src/policy.spec.ts
```

Expected: FAIL，36 个测试中 2 个失败：getter 覆写后再次出现间歇降级，克隆后自定义
`exec()` 从不匹配错误变为匹配。

- [ ] **Step 3: 用基线实现验证非零游标测试会失败**

临时恢复直接 `.test()` 的基线实现，仅运行 `lastIndex` 用例。Expected: `g` 的游标由 7
变为 34，`y` 从游标 7 开始导致本应命中的 URL 返回 false。

### Task 3: 隔离并恢复正则匹配游标

**Files:**
- Modify: `packages/interceptor/src/policy.ts:144-152`

- [ ] **Step 1: 让 RegExp 分支调用无状态辅助函数**

```ts
function matchesUrl(request: InterceptedRequest, matcher: RequestMatcher): boolean {
  if (matcher.url === undefined) return true
  if (matcher.url instanceof RegExp) return testRegExp(matcher.url, request.url)

  const target = matcher.url.startsWith('/')
    ? pathnameOf(request.url)
    : request.url
  return compileUrlPattern(matcher.url).test(target)
}
```

- [ ] **Step 2: 从游标 0 判定并在 finally 中恢复**

在 `matchesUrl()` 后新增：

```ts
function testRegExp(pattern: RegExp, value: string): boolean {
  const lastIndex = pattern.lastIndex
  try {
    if (lastIndex !== 0) pattern.lastIndex = 0
    return pattern.test(value)
  } finally {
    if (pattern.lastIndex !== lastIndex) pattern.lastIndex = lastIndex
  }
}
```

- [ ] **Step 3: 运行目标测试确认转绿**

Run:

```bash
npx vitest run packages/interceptor/src/policy.spec.ts
```

Expected: PASS，1 个测试文件、36 个测试全部通过。

- [ ] **Step 4: 运行 interceptor 包级验证**

Run:

```bash
npx vitest run packages/interceptor/src
npm run typecheck --workspace @wandkit/interceptor
```

Expected: interceptor 全部测试和类型检查通过。

### Task 4: 完整验证与审查记录

**Files:**
- Create: `docs/fix_20260731_正则规则状态污染/test-results.md`
- Create: `docs/fix_20260731_正则规则状态污染/review.md`

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

`test-results.md` 记录基线、红灯、绿灯、包级和完整验证数量；`review.md` 核对危险规则
不会间歇性降级、原正则状态不变、普通正则与 glob 不变、无公开 API 变化。

### Task 5: 提交、复审、推送与 PR

- [ ] **Step 1: 提交设计和实施计划**

```bash
git add -- 'docs/fix_20260731_正则规则状态污染/design.md' \
  'docs/fix_20260731_正则规则状态污染/plan.md'
git commit -m 'fix: 记录正则规则状态污染方案'
```

- [ ] **Step 2: 提交实现、测试和验证记录**

```bash
git add -- packages/interceptor/src/policy.ts \
  packages/interceptor/src/policy.spec.ts \
  'docs/fix_20260731_正则规则状态污染/test-results.md' \
  'docs/fix_20260731_正则规则状态污染/review.md'
git commit -m 'fix: 隔离状态型正则的匹配游标'
```

- [ ] **Step 3: 独立代码复审**

审查 `main..HEAD`，Critical 与 Important 必须为 0；若有问题，按 TDD 增加回归测试后修复
并重新复审。

- [ ] **Step 4: 首次推送同名分支**

```bash
git push -u origin fix_20260731_正则规则状态污染:fix_20260731_正则规则状态污染
```

- [ ] **Step 5: 创建独立 PR**

以 `main` 为目标创建 PR，正文包含状态污染时序、危险规则影响、TDD 红绿证据、完整验证
结果和独立复审结论；不自动合并。
