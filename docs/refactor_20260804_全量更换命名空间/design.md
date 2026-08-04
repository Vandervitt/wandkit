# Wandkit namespace 全量迁移设计

## 目标

将仓库内仍沿用历史品牌的包、公开标识和文档统一迁移到 Wandkit，避免 npm 包名、导入路径、浏览器运行时标识与项目名称不一致。

## 迁移矩阵

| 范围 | 迁移前 | 迁移后 |
| --- | --- | --- |
| 核心包 | 历史无 scope 包名 | `wandkit` |
| 扩展包 | 历史 npm scope | `@wandkit/*` |
| 导出类/类型 | 历史品牌前缀 | `Wandkit*`、`WandkitMessages` |
| Web Components | 历史元素名前缀 | `<wandkit-*>` |
| CSS 定制变量/动画 | 历史缩写前缀 | `--wandkit-*`、`wandkit-*` |
| DOM data attribute | 历史 data 前缀 | `data-wandkit-replay` |
| 跨 bundle Symbol | 历史包 scope | `@wandkit/interceptor.*` |
| 页面同步 query key | 历史品牌前缀 | `wandkitRequestId` |
| Trace 存储/全局变量 | 历史品牌前缀 | `wandkit:traces:v1`、`__WANDKIT_TRACE__` |

## 兼容性

这是有意的破坏性变更，不保留旧包名、旧导出名、旧标签、旧 CSS 变量或旧运行时 key 的兼容别名。调用方需要一次性迁移到新 namespace。包版本暂保持 `0.1.0`；新包名在 npm registry 当前未被占用。

## 实施边界

- 更新所有受 Git 跟踪的源码、测试、示例、包清单、lockfile、README，以及仍作为当前技术参考的设计/计划/评审文档。
- 带日期的历史 `test-results.md` 保留执行当时的真实包名，不把过去的验证结果改写成新 namespace。
- 不改变业务逻辑、权限模型、协议字段或功能行为；只修改品牌 namespace 及其直接公开契约。
- 不修改 ignored 的 `dist/` 构建产物，最终通过重新构建验证生成物。

## 验证

- 运行 namespace 契约脚本，核对五个发布包名、Web Component 标签、运行时 key 与 CSS namespace。
- 扫描当前源码、配置、README、示例与构建产物，确保旧 package/class/tag/key/CSS namespace 无残留；历史测试记录单独作为审计留档。
- 执行 `npm install` 更新 workspace 链接和 `package-lock.json`。
- 在临时移走全部 ignored `dist/` 后执行测试和类型检查，证明 clean checkout 不依赖本地旧构建产物。
- 执行 `npm run verify`，覆盖 58 个测试文件、类型检查与所有 workspace 构建。
