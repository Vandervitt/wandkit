# 实施评审

## 结论

namespace 迁移覆盖完整，未发现需要阻止交付的新增问题。改动是有意的破坏性 API 变更，不提供历史 namespace 兼容层。

## 覆盖核对

| 层级 | 结果 |
| --- | --- |
| npm 包与依赖 | 根 workspace、core、四个扩展包、lockfile 和 workspace symlink 已统一 |
| TypeScript API | 导出类、配置类型、源码 import、paths 和 externals 已统一 |
| 浏览器契约 | Web Component、CSS、data attribute、Symbol、query key 和 trace key 已统一 |
| 使用资料 | 根 README、包 README、示例和当前技术参考文档已统一；历史测试结果保留原始事实 |
| 测试基础设施 | Vitest 不再依赖 ignored `dist` 的偶然存在，内部运行时依赖直接解析源码 |
| clean checkout | workspace 与 eval tsconfig 已补齐源码 paths，临时移走五个 `dist/` 后测试和类型检查通过 |

## 兼容性提醒

调用方必须同步修改 npm 依赖、import 路径、导出类型/类名、Web Component 标签、CSS 变量、持久化 key 和跨 bundle Symbol。旧 localStorage trace 不会自动迁移到新 key。

## 非本次范围

core 的 Node ESM dayjs 插件加载问题与依赖安全告警均为既有事项，建议分别建立后续修复任务；本分支不混入无关依赖或构建兼容性改造。

## 独立复核

首次审查指出 clean checkout 可能依赖 ignored `dist`、历史测试记录被改写，以及 chat CSS 变量文档不完整。补齐 TypeScript 源码 paths、恢复历史 `test-results.md`、修正文档并完成无 `dist` 验证后，复核结论为 `Ready`，无 Critical、Important 或 Minor 遗留项。
