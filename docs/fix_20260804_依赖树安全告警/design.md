# 依赖树 5 个安全告警修复设计

> 日期：2026-08-04
>
> 分支：`fix_20260804_依赖树安全告警`
>
> 状态：已实现并通过安全与兼容性验证

## 1. 现状与结论

当前 `npm audit --json` 稳定报告 5 个存在漏洞的包：1 个 critical、2 个 high、
2 个 moderate。问题同时覆盖生产传递依赖和开发工具链，不能只运行
`npm audit fix`：npm 给出的自动方案会把 Vite 提升到 8.x，破坏仓库现有的
Node 18 兼容声明。

采用兼容性优先的最小完整方案：

1. 将直接开发依赖升级到仍支持 Node 18 的最低安全版本：
   `vite@6.4.3`、`vitest@3.2.6`、`vite-node@3.2.4`。
2. 保留最新版 `tsup@8.5.1`，在根开发依赖中精确声明不受当前 advisory 影响的
   `esbuild@0.27.2`，同时满足 tsup 的 `^0.27.0` 依赖和 bundle-require 的
   `>=0.18` peer。
3. 利用 `ajv@8.20.0` 已有的 `fast-uri@^3.0.1` 范围，将 lockfile 解析结果更新
   到 `fast-uri@3.1.5`，不新增顶层生产依赖。

## 2. 告警路径与安全边界

| 包 | 当前版本 | 依赖路径 | 受影响范围 | 目标状态 |
|---|---:|---|---|---|
| `vitest` | `1.6.1` | 根直接开发依赖 | `<3.2.6` | `3.2.6` |
| `vite` | `5.4.21` | 根直接开发依赖，并被 Vitest/vite-node 使用 | `<=6.4.2` | `6.4.3` |
| `vite-node` | `1.6.1` | 根直接开发依赖，并被 Vitest 使用 | `<=2.2.0-beta.2` | `3.2.4` |
| `esbuild` | `0.21.5`、`0.27.7` | Vite；tsup 与 bundle-require peer | `<=0.24.2` 或 `0.27.3 - 0.28.0` | Vite 使用 `0.25.x`；根安全提供者为 `0.27.2` |
| `fast-uri` | `3.1.4` | `wandkit → ajv@8.20.0 → fast-uri` | `3.0.0 - 3.1.4` | `3.1.5` |

对应 advisory 包括：

- `GHSA-5xrq-8626-4rwp`：Vitest UI server 任意文件读取和执行。
- `GHSA-4w7w-66w2-5vf9`、`GHSA-v6wh-96g9-6wx3`、
  `GHSA-fx2h-pf6j-xcff`：Vite 路径处理和 Windows 本地工具链问题。
- `GHSA-67mh-4wv8-2f99`、`GHSA-g7r4-m6w7-qqqr`：esbuild 开发服务器
  跨源读取和 Windows 任意文件读取问题。
- `GHSA-7p8r-x3mc-p8w7`：fast-uri 反斜杠 authority introducer 导致 host confusion。

安全不变式：

- 完整 npm 安装树不包含上述受影响版本，`npm audit` 返回 0 个漏洞。
- 本地测试和 Vite 开发服务不暴露已知的任意文件读取、路径绕过或跨源读取版本。
- Ajv Schema 编译链不再携带 `fast-uri <3.1.5`。

需要保持的合法行为：

- `engines.node` 继续声明 `>=18`，所选直接工具版本均支持 Node 18。
- 58 个既有测试文件、864 个测试的行为保持。
- 所有 workspace 类型检查和 tsup 构建保持。
- `vite-node` 驱动的示例以及 Vite 驱动的 page-agent E2E 保持。
- 不修改任何运行时代码、公共 API、权限模型或业务错误语义。

## 3. 方案选择

| 方案 | 做法 | 兼容性 | 安全闭环 | 结论 |
|---|---|---|---|---|
| A | 使用 `npm audit fix --force` 升到 Vite 8/Vitest 4 | Vite 8 不支持 Node 18 | 仍需单独处理 tsup 的 esbuild | 不采用 |
| B | 升到 Vite 6.4.3、Vitest 3.2.6、vite-node 3.2.4，并在根精确声明 esbuild 0.27.2 | 保留 Node 18，统一满足 tsup 依赖和 bundle-require peer | 可覆盖全部 5 个包 | **采用** |
| C | 全局强制 esbuild 0.28.1 | 会越过 Vite 6 的 `^0.25.0` 和 tsup 的 `^0.27.0` 声明 | 能清除版本告警，但契约风险更高 | 不采用 |

`tsup@8.5.1` 是当前 latest，依赖 `esbuild@^0.27.0`；它的子依赖
`bundle-require@5.1.0` 又声明 `esbuild@>=0.18` peer。首次尝试仅对 tsup 使用
override 后，npm 仍在根为 bundle-require 自动安装 `esbuild@0.27.7`，审计残留
1 个 low。`0.27.2` 同时满足两条声明，且位于 advisory 引入版本 `0.27.3` 之前，
因此改为根精确开发依赖；Vite 的 `^0.25.0` 继续解析自己的嵌套节点，不受影响。

## 4. 文件与契约

| 文件 | 操作 | 职责 |
|---|---|---|
| `package.json` | 修改 | 更新三个直接工具版本，并增加精确的根 esbuild 安全提供者 |
| `package-lock.json` | 修改 | 固化全部安全解析版本和完整性校验值 |
| `packages/core/src/runtime/agentRuntime.spec.ts` | 修改 | 迁移 3 个 Vitest mock 泛型声明 |
| `packages/interceptor/src/channels.spec.ts` | 修改 | 迁移 4 个确认回调 mock 泛型声明 |
| `packages/interceptor/src/form.spec.ts` | 修改 | 迁移测试 helper 的确认回调 mock 泛型声明 |
| `packages/interceptor/src/interceptor.spec.ts` | 修改 | 迁移 3 个确认回调 mock 泛型声明 |
| `docs/fix_20260804_依赖树安全告警/design.md` | 新增 | 记录安全路径、兼容决策和边界 |
| `docs/fix_20260804_依赖树安全告警/plan.md` | 新增 | 记录红—绿实施步骤 |
| `docs/fix_20260804_依赖树安全告警/test-results.md` | 新增 | 记录实际审计和项目验证结果 |
| `docs/fix_20260804_依赖树安全告警/review.md` | 新增 | 记录最终 scope、安全闭环和绕过面复核 |

## 5. 验证策略

1. 红灯：`npm audit --json` 必须先报告 5 个目标包。
2. 依赖树：`npm ls vitest vite vite-node esbuild fast-uri --all` 必须只出现安全版本。
3. 安全闭环：`npm audit --json` 必须退出 0 且 total 为 0。
4. 合法行为：`npm run verify` 和 `npm run example` 必须保持通过。
5. Vite 集成：运行 deterministic page-agent E2E，确认 Vite 6 dev server 与 Playwright 链路保持。
6. 变更审查：检查根 esbuild 同时满足 tsup 与 bundle-require，Vite 保持独立节点，
   lockfile 不包含旧版本或无关顶层升级。

Vitest 3 将 `vi.fn<TArgs, TResult>` 改为 `vi.fn<TProcedure>`。依赖升级后的首次
`npm run verify` 中，58 个测试文件、864 个运行时测试全部通过，但 TypeScript 在
4 个 spec 文件的 11 个旧式 mock 泛型声明处失败。兼容迁移只把参数元组与返回值
组合为等价函数类型，例如 `vi.fn<ConfirmRequestHandler>()`；测试实现和断言保持不变。

## 6. 风险与非目标

| 风险 | 控制 |
|---|---|
| Vitest 1 → 3 的测试运行行为变化 | 修复前后执行完整测试集并核对数量 |
| Vitest mock 类型 API 变更导致 spec 无法类型检查 | 仅迁移 11 个 mock 声明，并重跑 typecheck 与完整测试 |
| Vite 5 → 6 的开发服务器行为变化 | 执行 page-agent E2E |
| 根 esbuild 固定到 0.27.2 影响 tsup 或 bundle-require | 执行所有 workspace build |
| npm 重算 lockfile 带入无关漂移 | 逐段审查 `package.json` 和 `package-lock.json` diff |

非目标：不升级其他过期依赖，不改业务源码，不修改生产数据库或外部系统，不合并到
`main`/`dev`/`test`，本轮默认不 push。
