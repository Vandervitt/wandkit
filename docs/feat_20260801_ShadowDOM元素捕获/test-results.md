# Shadow DOM 元素捕获测试结果

- 日期：2026-08-01
- 分支：`feat_20260801_ShadowDOM元素捕获`
- 基线：`main @ 5dbb4c4`

## 基线验证

| 命令 | 退出码 | 结果 |
| --- | ---: | --- |
| `npm run verify` | 0 | 47 个测试文件、705/705 测试通过；所有 workspace 类型检查和构建通过 |

## TDD 红绿记录

| 阶段 | 状态 | 命令 | 退出码 | 关键结果 |
| --- | --- | --- | ---: | --- |
| composed tree 基础模块 | RED | `npx vitest run packages/executor/src/composedTree.spec.ts` | 1 | `./composedTree` 模块不存在，测试按预期在导入阶段失败 |
| composed tree 基础模块 | GREEN | `npx vitest run packages/executor/src/composedTree.spec.ts` | 0 | 1 个文件、9/9 测试通过 |
| composed tree 回归 | GREEN | `npx vitest run packages/executor/src` | 0 | 12 个文件、183/183 测试通过 |
| 页面快照接入 | RED | `npx vitest run packages/executor/src/snapshot.spec.ts packages/executor/src/crossFramework.spec.ts` | 1 | 5 条新增 open Shadow DOM、slot、Tree Scope 和 cursor 场景失败，32 条既有用例通过 |
| 页面快照接入 | GREEN | `npx vitest run packages/executor/src/composedTree.spec.ts packages/executor/src/snapshot.spec.ts packages/executor/src/crossFramework.spec.ts` | 0 | 3 个文件、46/46 测试通过 |
| 页面快照回归 | GREEN | `npx vitest run packages/executor/src` | 0 | 12 个文件、188/188 测试通过 |
| 控制器整页扫描 | RED | `npx vitest run packages/executor/src/controller.spec.ts` | 1 | 影子树表单校验和最大滚动容器 2 条失败，其余 28 条通过 |
| 控制器整页扫描 | GREEN | `npx vitest run packages/executor/src/controller.spec.ts` | 0 | 30/30 测试通过 |
| 复合下拉跨边界 | RED | `npx vitest run packages/executor/src/controller.spec.ts` | 1 | 展开状态祖先/后代与 Host 内部元素排除 3 条失败，其余 30 条通过 |
| 复合下拉跨边界 | GREEN | `npx vitest run packages/executor/src/controller.spec.ts` | 0 | 33/33 测试通过 |
| 控制器最终回归 | GREEN | `npx vitest run packages/executor/src` | 0 | 12 个文件、196/196 测试通过 |

每一处新增生产能力都由对应失败用例驱动并完成 RED/GREEN；closed Root、隐藏 Host、
动作映射和索引失效等边界保护在所属 RED 批次中已通过，用于证明既有安全边界未被扩大。

## 最终验证

| 命令 | 退出码 | 结果 |
| --- | ---: | --- |
| `npx vitest run packages/executor/src` | 0 | 12 个测试文件、196/196 测试通过 |
| `npm run verify` | 0 | 48 个测试文件、727/727 测试通过；所有 workspace 类型检查和构建通过 |
| `git diff --check` | 0 | 无空白错误 |

测试期间 `tools.spec.ts` 仍输出 jsdom 的既有提示：
`Not implemented: HTMLFormElement's requestSubmit() method`。相关测试均通过，该提示不是本次改动引入的失败。

## E2E 说明

未执行浏览器 E2E：仓库当前没有 Shadow DOM 浏览器 E2E 夹具，本次改动是 executor 内部 DOM
遍历与控制逻辑，不包含应用页面或可启动的产品 UI。已使用 jsdom 单元/集成用例覆盖 open、nested、
closed、slot 分发、Tree Scope、动作、校验、下拉和滚动契约，并通过 executor 构建验证。
