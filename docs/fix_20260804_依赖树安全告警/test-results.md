# 依赖树安全告警修复测试结果

> 日期：2026-08-04
>
> 分支：`fix_20260804_依赖树安全告警`
>
> 实现提交：`ea1f981f1214c4ba79e0ef007f787772e650aa65`

## 1. 红—绿安全证据

| 阶段 | 命令 | 退出码 | 结果 |
|---|---|---:|---|
| 修复前 | `npm audit --json` | 1 | 5 个漏洞包：1 critical、2 high、2 moderate；涉及 `vitest`、`vite`、`fast-uri`、`vite-node`、`esbuild` |
| 第一版 esbuild 父级 override | `npm audit --json` | 1 | 已清除 4 个包，但 `bundle-require` peer 仍自动安装 `esbuild@0.27.7`，残留 1 low |
| 根 esbuild 精确提供者 | `npm audit --json` | 0 | `metadata.vulnerabilities.total = 0` |
| 主 Agent 最终复验 | `npm audit --json` | 0 | 0 info、0 low、0 moderate、0 high、0 critical，total 0 |

原始告警不再复现：最终审计结果的 `vulnerabilities` 为空对象，原来的 5 个包均未
再次报告 advisory。

## 2. 最终依赖树

命令：

```bash
npm ls vitest vite vite-node esbuild fast-uri --all
```

结果：exit 0，无 `invalid`、`extraneous` 或 peer 问题。

```text
root esbuild@0.27.2
tsup@8.5.1 -> esbuild@0.27.2 deduped
tsup -> bundle-require@5.1.0 -> esbuild@0.27.2 deduped
vite@6.4.3 -> esbuild@0.25.12
vite-node@3.2.4 -> vite@6.4.3
vitest@3.2.7 -> vite-node@3.2.4 / vite@6.4.3
ajv@8.20.0 -> fast-uri@3.1.5
```

所有版本均位于当前 audit advisory 的安全范围外。

## 3. Vitest 类型兼容红—绿证据

| 阶段 | 命令 | 退出码 | 结果 |
|---|---|---:|---|
| 升级后、类型迁移前 | `npm run typecheck` | 2 | 4 个 spec 文件的 11 个 `vi.fn<TArgs, TResult>` 报 TS2558，并连锁推断为 `never` |
| 类型迁移后 | `npm run typecheck` | 0 | 所有 workspace 与 page-agent TypeScript 检查通过 |
| 定向回归 | `npx vitest run packages/core/src/runtime/agentRuntime.spec.ts packages/interceptor/src/channels.spec.ts packages/interceptor/src/form.spec.ts packages/interceptor/src/interceptor.spec.ts` | 0 | 4 个测试文件、176 个测试通过 |

迁移只把旧的参数元组/返回值双泛型改为完整函数类型泛型，未修改测试行为或断言。

## 4. 合法行为与完整门槛

| 命令 | 退出码 | 结果 |
|---|---:|---|
| 修复前 `npm run verify` | 0 | 58 个测试文件、864 个测试通过；类型检查和所有 workspace 构建通过 |
| 最终 `npm run verify` | 0 | 58 个测试文件、864 个测试通过；类型检查和所有 workspace 构建通过 |
| 修复前 `npm run example` | 0 | vite-node 四个示例场景完成 |
| 最终 `npm run example` | 0 | vite-node 四个示例场景保持 |
| `npm run eval:page-agent` | 0 | Playwright 3/3 通过；Vite 6 development server 真实链路通过 |
| `git diff --check 9389dbe..ea1f981` | 0 | 无空白或补丁格式错误 |

E2E 前后 `lsof -nP -iTCP:4173 -sTCP:LISTEN` 均 exit 1、无监听；本轮没有复用用户
服务，也没有遗留自行启动的开发服务器。

## 5. 审查结果

| 审查 | 结果 |
|---|---|
| 规格符合性审查 | `✅ Spec compliant`；提交恰好包含 6 个目标实现文件 |
| 代码质量与安全审查 | Ready to merge: Yes；0 Critical、0 Important、1 Minor |
| 主 Agent diff 复核 | 11 个 mock 只做等价类型迁移；lockfile 112 个版本变化节点均属于目标工具链、平台包或 fast-uri |

质量审查的 Minor 是根 `esbuild@0.27.2` 精确 pin 的维护成本。本轮保留精确版本，
因为改为 `^0.27.2` 会在当前 registry 重新解析到受 advisory 影响的 `0.27.7`；待
tsup 发布支持安全新版本后可移除该临时直接依赖。

## 6. 已知非阻塞输出

- Vitest 3 报告 `environmentMatchGlobs` deprecated；当前配置仍生效，测试全过。
  迁移到 `test.projects` 属于后续配置重构，不影响本次安全闭环。
- 3 个既有 jsdom 测试继续输出 `HTMLFormElement.requestSubmit()` 未实现；修复前已存在。
- Playwright webServer 输出 `NO_COLOR` 被 `FORCE_COLOR` 覆盖的 Node warning；E2E 仍 3/3 通过。

## 7. 未执行或未通过项

无。计划中与本次改动相关的审计、依赖树、类型检查、单元测试、构建、示例和 E2E
均已实际执行并读取退出码。
