# 测试结果

## 修改前基线

| 检查 | 结果 |
| --- | --- |
| namespace 包名契约 | 按预期失败，根 workspace 尚未使用目标名称 |
| `npm run verify` | 通过：58 个测试文件、864 个测试；全部 workspace 类型检查与构建通过 |

## 开发期验证

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过：`wandkit` 与四个 `@wandkit/*` workspace、页面评估 tsconfig 均通过 |
| namespace 包名契约 | 通过：根 workspace、core 与四个扩展包名称完全匹配 |
| 相关测试集 | 通过：19 个测试文件、391 个测试 |
| 回归红灯 | `confirmUi.spec.ts` 稳定复现 stale `dist` 返回旧 Web Component 标签 |
| 回归绿灯 | Vitest 将 `wandkit` 与 `@wandkit/ui` 精确映射到源码后，`confirmUi.spec.ts` 12/12 通过 |
| clean typecheck 红灯 | 临时移走 `ui/dist` 后，interceptor 无法解析 `@wandkit/ui`，按预期失败 |
| clean typecheck 绿灯 | 为 interceptor 增加 `@wandkit/ui` 源码 path 后，同一命令通过 |
| 全部 dist clean 验证 | 临时移走五个 workspace 的 `dist/` 后，58 个测试文件、864 个测试及全部类型检查通过 |

## 最终验证

| 检查 | 结果 |
| --- | --- |
| `npm run verify` | 通过，退出码 0；58 个测试文件、864 个测试全部通过；全部类型检查和五个 workspace 构建通过 |
| 当前源码/配置/README/示例残留扫描 | 无历史 package/class/tag/key/CSS namespace 残留 |
| `packages/*/dist` 残留扫描 | 无历史 namespace 残留 |
| 历史测试记录 | 保留执行当时的真实包名，不纳入当前 namespace 残留判定 |
| `npm ls --workspaces --depth=0` | core 为 `wandkit@0.1.0`，四个扩展包均为 `@wandkit/*@0.1.0` |
| `npm pack --dry-run --workspaces --json` | 五个发布包均以新名称生成，文件清单正常 |
| 构建产物 namespace 冒烟 | CJS core + ESM UI/chat 契约通过，运行时 key 与四个 Web Component 标签均为 Wandkit |
| `git diff --check` | 通过，无空白错误 |

## 已知但未纳入本次改动的问题

- `npm install` 报告依赖树存在 5 个安全告警（2 moderate、2 high、1 critical）；未执行可能引入破坏性升级的自动修复。
- core 的 Node ESM 入口会因 `dayjs/plugin/utc` 与 `dayjs/plugin/timezone` 缺少 `.js` 后缀而加载失败。该问题在 `main` 已存在，CJS 入口正常，本次 namespace 重构未修改相关实现。
- executor 的 3 条 jsdom 测试仍输出 `HTMLFormElement.requestSubmit()` 未实现提示，但断言全部通过；与修改前基线一致。
