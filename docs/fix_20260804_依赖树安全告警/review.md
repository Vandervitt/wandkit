# 依赖树安全告警修复评审

> Outcome：`fixed`

## 1. 漏洞路径与安全不变式

修复前存在四条实际依赖路径：

```text
root vitest@1.6.1 -> vite@5.4.21 -> esbuild@0.21.5
root vite-node@1.6.1 -> vite@5.4.21
root tsup@8.5.1 -> esbuild@0.27.7
wandkit -> ajv@8.20.0 -> fast-uri@3.1.4
```

安全不变式是完整安装树不包含 audit 当前列出的受影响版本，同时保留 Node 18、
测试、构建、vite-node 示例和 Vite development server 的合法行为。

## 2. 最小完整修复策略

- Vite 升到 6.4.3，避开 `<=6.4.2` 的 advisory，同时继续支持 Node 18。
- Vitest 声明升到 `^3.2.6`，lockfile 解析为 3.2.7；vite-node 升到 3.2.4。
- 根精确声明 `esbuild@0.27.2`，同时满足 tsup `^0.27.0` 与 bundle-require
  `>=0.18` peer；Vite 继续使用自己的 `esbuild@0.25.12`。
- fast-uri 通过 Ajv 既有 `^3.0.1` 范围更新到 3.1.5，不增加顶层生产依赖。
- 将 11 个旧式 Vitest mock 双泛型迁移为完整函数类型，保持测试行为不变。

第一版只对 tsup 使用 override 时，bundle-require peer 仍产生根
`esbuild@0.27.7`，审计残留 1 low；因此该方案被证据否决，没有叠加更多 override。
根精确依赖是当前 npm peer 布局下最窄、可复现且满足上游声明的完整方案。

## 3. 变更文件

实现提交 `ea1f981`：

| 文件 | 变更 |
|---|---|
| `package.json` | 更新 Vite/Vitest/vite-node，增加根 esbuild 安全版本 |
| `package-lock.json` | 固化安全依赖树和 integrity |
| `packages/core/src/runtime/agentRuntime.spec.ts` | 迁移 3 个 mock 函数类型 |
| `packages/interceptor/src/channels.spec.ts` | 迁移 4 个 ConfirmRequestHandler mock |
| `packages/interceptor/src/form.spec.ts` | 迁移测试 helper mock |
| `packages/interceptor/src/interceptor.spec.ts` | 迁移 3 个 ConfirmRequestHandler mock |

过程与验证文档位于本目录的 `design.md`、`plan.md`、`test-results.md`、`review.md`。

## 4. 安全闭环复核

- 最终 `npm audit --json` exit 0，total 0；原始 5 个包均不再报告。
- `npm ls` 显示根、tsup、bundle-require 共用 `esbuild@0.27.2`，Vite 独立使用
  `0.25.12`，没有受影响的 `0.27.7` 或 `0.21.5`。
- fast-uri 只有 `3.1.5`，不存在第二个旧节点。
- package.json 没有全局 override，不会强制 Vite 越过它声明的 esbuild 范围。
- lockfile 版本差异只涉及目标工具链、对应平台包和 fast-uri。

原始问题已证明不再复现：相同的 `npm audit --json` 从 5 个漏洞包、exit 1 转为
空 vulnerabilities、exit 0。

## 5. 合法行为保持

- 修复前后均为 58 个测试文件、864 个测试通过。
- 所有 workspace 与 page-agent 类型检查通过。
- 所有 workspace tsup 构建通过，证明 esbuild pin 没有破坏构建链。
- vite-node 示例四个场景通过。
- page-agent Playwright 3/3 通过，证明 Vite 6 development server 真实链路保持。
- 没有修改业务源码、公共 API、权限控制、错误语义或运行时配置。

## 6. 变更感知绕过面

- 检查了 tsup 直接依赖与 bundle-require peer 两条等价 esbuild 路径。
- 检查了 Vite 自己的嵌套 esbuild，确认未被根版本错误覆盖。
- 检查了 Ajv 的 fast-uri 生产路径。
- 检查了 Vitest 3 类型签名和所有 11 个旧调用点，没有残留双泛型声明。
- 规格审查为 `✅ Spec compliant`；质量审查 0 Critical、0 Important。

## 7. 剩余风险与后续项

- 根 `esbuild@0.27.2` 是临时精确 pin。后续 tsup 若发布依赖安全版本，应移除该
  顶层开发依赖并重新审计；在此之前不能改为 caret，否则会重新解析到 0.27.7。
- `environmentMatchGlobs` 在 Vitest 3 中 deprecated，但当前仍受支持且验证通过。
  后续可单独迁移到 `test.projects`，避免把配置重构混入安全补丁。
- 既有 jsdom `requestSubmit()` 和 Playwright 颜色环境 warning 均不影响退出码，
  已在测试结果中显式记录。

本轮没有跳过相关验证，没有写入外部系统，没有 push，也没有合并到保护分支。
