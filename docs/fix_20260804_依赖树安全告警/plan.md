# 依赖树 5 个安全告警修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除 npm 依赖树中 5 个存在漏洞的包，同时保留 Node 18、测试、构建、示例和 Vite E2E 行为。

**Architecture:** 直接工具链升级到最低安全且支持 Node 18 的版本；在根精确声明 esbuild 0.27.2，同时满足 latest tsup 的依赖和 bundle-require 的 peer；fast-uri 仅通过既有 Ajv 范围更新 lockfile。以 `npm audit` 作为红—绿安全证据，以完整 verify、vite-node 示例和 page-agent E2E 证明行为保持。

**Tech Stack:** npm workspaces、lockfile v3、Vite、Vitest、vite-node、tsup、esbuild、Ajv、fast-uri、TypeScript、Playwright。

---

设计事实源：[design.md](./design.md)

## 文件职责锁定

| 文件 | 职责 |
|---|---|
| `package.json` | 直接工具版本与根 esbuild 安全提供者 |
| `package-lock.json` | 可复现的安全依赖树 |
| `vitest.config.ts` | 兼容性检查对象，本轮预期不修改 |
| `evals/page-agent/vite.config.ts` | Vite 6 集成检查对象，本轮预期不修改 |
| `packages/core/src/runtime/agentRuntime.spec.ts` | Vitest 3 mock 函数类型兼容迁移 |
| `packages/interceptor/src/channels.spec.ts` | Vitest 3 确认回调 mock 类型兼容迁移 |
| `packages/interceptor/src/form.spec.ts` | Vitest 3 测试 helper mock 类型兼容迁移 |
| `packages/interceptor/src/interceptor.spec.ts` | Vitest 3 确认回调 mock 类型兼容迁移 |
| `docs/fix_20260804_依赖树安全告警/test-results.md` | 真实命令、退出码和数量 |
| `docs/fix_20260804_依赖树安全告警/review.md` | 最终安全与 scope 自审 |

### Task 1：固化漏洞红灯与合法行为基线

- [x] **Step 1：运行完整依赖审计**

Run: `npm audit --json`

Observed: exit 1；5 个包，1 critical、2 high、2 moderate：`vitest`、`vite`、
`fast-uri`、`vite-node`、`esbuild`。

- [x] **Step 2：确认实际依赖路径**

Run: `npm ls vitest vite vite-node esbuild fast-uri --all`

Observed: Vitest/Vite/vite-node 为根直接开发依赖；Vite 使用 esbuild 0.21.5，
tsup 使用 esbuild 0.27.7；Ajv 使用 fast-uri 3.1.4。

- [x] **Step 3：运行完整行为基线**

Run: `npm run verify`

Observed: exit 0；58 个测试文件、864 个测试通过；类型检查和所有 workspace 构建通过。
已有 3 条 jsdom `requestSubmit()` stderr，升级前即存在。

- [x] **Step 4：运行 vite-node 示例基线**

Run: `npm run example`

Observed: exit 0；四个示例场景完成。

### Task 2：实施最小依赖修复

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`

- [x] **Step 1：更新直接工具版本并增加根 esbuild 安全提供者**

将根 `package.json` 的相关部分改为：

```json
"esbuild": "0.27.2",
"vite": "^6.4.3",
"vite-node": "^3.2.4",
"vitest": "^3.2.6"
```

不增加全局或父级 `overrides`。根精确版本同时满足 tsup 的 `^0.27.0` 和
bundle-require 的 `>=0.18` peer；Vite 的 `^0.25.0` 使用独立嵌套节点。

- [x] **Step 2：重算直接依赖 lockfile**

Run: `npm install --package-lock-only --ignore-scripts --no-audit`

Expected: exit 0；lockfile 解析出 Vite 6.4.3、Vitest `^3.2.6` 范围内版本、
vite-node 3.2.4；根 esbuild 0.27.2 同时满足 tsup 和 bundle-require。

- [x] **Step 3：更新 fast-uri 的 lockfile 节点**

Run: `npm update fast-uri --package-lock-only --ignore-scripts --no-audit`

Expected: exit 0；`fast-uri` 为 3.1.5，不修改 Ajv 直接依赖契约。

- [x] **Step 4：审查依赖 diff 并同步本地安装树**

Run:

```bash
git diff -- package.json package-lock.json
npm install --ignore-scripts --no-audit
git diff --check
```

Expected: 只包含目标工具链的必要传递变化；安装后无额外 tracked diff；
`git diff --check` 退出 0。

- [x] **Step 5：迁移 Vitest 3 mock 泛型签名**

修复前证据：升级依赖后的 `npm run typecheck` exit 2；58 个运行时测试文件和
864 个测试已经通过，错误仅来自 4 个 spec 文件的 11 个 `vi.fn<TArgs, TResult>`。

将声明改为单一完整函数类型：

```ts
vi.fn<ConfirmRequestHandler>(async () => true)
vi.fn<(context: ToolExecutionContext, input: Input) => Promise<Result>>()
```

不得修改测试行为、断言、业务源码或 Vitest 配置。

Run:

```bash
npm run typecheck
npx vitest run packages/core/src/runtime/agentRuntime.spec.ts \
  packages/interceptor/src/channels.spec.ts \
  packages/interceptor/src/form.spec.ts \
  packages/interceptor/src/interceptor.spec.ts
```

Expected: 两条命令 exit 0；受影响测试保持通过。

### Task 3：验证安全闭环与合法行为

- [x] **Step 1：检查最终依赖树**

Run: `npm ls vitest vite vite-node esbuild fast-uri --all`

Expected: 不出现审计受影响范围内的版本，不出现 invalid/extraneous。

- [x] **Step 2：确认原始告警转绿**

Run: `npm audit --json`

Expected: exit 0；`metadata.vulnerabilities.total` 为 0。

- [x] **Step 3：执行完整项目门槛**

Run: `npm run verify`

Expected: exit 0；58 个测试文件、864 个测试保持通过，类型检查和构建通过。

- [x] **Step 4：验证 vite-node 合法行为**

Run: `npm run example`

Expected: exit 0；四个场景保持。

- [x] **Step 5：验证 Vite 6 的真实集成边界**

Run: `npm run eval:page-agent`

Expected: exit 0；deterministic page-agent Playwright 用例通过，测试产物继续位于
项目约定的 `.playwright` 或 `.playwright-mcp` 目录。

### Task 4：完成结果记录、自审与提交

**Files:**

- Create: `docs/fix_20260804_依赖树安全告警/test-results.md`
- Create: `docs/fix_20260804_依赖树安全告警/review.md`
- Modify: `docs/fix_20260804_依赖树安全告警/plan.md`

- [x] **Step 1：写入真实验证结果**

记录每条命令的退出码、审计数量、依赖树版本、测试数量及任何已知 warning。
禁止把预期值当作实际值。

- [x] **Step 2：完成变更感知安全复核**

核对：原始 5 个包不再复现；根 esbuild 0.27.2 同时满足 tsup 与 bundle-require，
且没有影响 Vite 的 0.25.x 节点；fast-uri 只有安全版本；Node 18 引擎契约未被直接
升级破坏；源码和公共 API 无变化。

- [x] **Step 3：检查最终 diff 和工作区**

Run:

```bash
git diff --check
git diff --stat
git status --short
git branch --show-current
```

Expected: 当前分支为 `fix_20260804_依赖树安全告警`；变更仅限本计划列出的目标文件；
无格式错误。

- [x] **Step 4：分组提交**

每次 `git add` 和 `git commit` 前重新运行 `git branch --show-current`。

```bash
git add package.json package-lock.json \
  packages/core/src/runtime/agentRuntime.spec.ts \
  packages/interceptor/src/channels.spec.ts \
  packages/interceptor/src/form.spec.ts \
  packages/interceptor/src/interceptor.spec.ts
git commit -m 'fix: 修复依赖树安全告警'

git add docs/fix_20260804_依赖树安全告警
git commit -m 'fix: 记录依赖安全修复验证'
```

本轮不 push，不合并到 `main`、`dev` 或 `test`。
