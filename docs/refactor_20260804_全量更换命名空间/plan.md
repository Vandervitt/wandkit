# Wandkit Namespace Migration Implementation Plan

**Goal:** 将历史品牌的全部公开 namespace 迁移为 Wandkit，并保持业务行为不变。

**Architecture:** 以单一映射表同步更新包元数据、TypeScript 契约、浏览器运行时标识和文档。依赖关系仍保持 core + 四个扩展包的现有结构，仅替换包解析名称与公开前缀。

**Tech Stack:** TypeScript、npm workspaces、tsup、Vitest、Web Components。

---

## 任务 1：建立失败基线

- [x] 运行 namespace 契约脚本，确认当前包名尚未使用目标 namespace，脚本按预期失败。
- [x] 记录修改前 `npm run verify` 结果，排除既有失败。

## 任务 2：迁移包解析 namespace

- [x] 修改根目录与五个 workspace 的 `package.json`。
- [x] 修改 `tsconfig.json` paths、`tsup.config.ts` externals 和源码 import。
- [x] 运行 `npm install`，更新 `package-lock.json` 与本地 workspace symlink。

## 任务 3：迁移浏览器公开 namespace

- [x] 将历史品牌前缀的导出类和类型统一改为 `Wandkit*` / `WandkitMessages`。
- [x] 将 Web Component 标签、CSS 变量和动画前缀改为 `wandkit`。
- [x] 将 data attribute、Symbol、query key、trace storage/global key 改为 `wandkit`。
- [x] 同步修改所有相关单元测试断言。

## 任务 4：迁移使用说明

- [x] 更新根 README、包 README、examples 和仍作为当前技术参考的过程文档。
- [x] 修正文案中因机械替换而失真的“仍沿用旧包名”等描述。
- [x] 恢复带日期的历史 `test-results.md` 原文，保留执行当时的审计事实。

## 任务 5：验证与评审

- [x] 运行 namespace 契约脚本并确认通过。
- [x] 运行当前契约与构建产物的旧 namespace 残留扫描并确认无结果；历史测试记录单独留档。
- [x] 运行 `npm run verify`。
- [x] 临时移走全部 workspace `dist/`，确认测试和类型检查在 clean checkout 条件下仍通过。
- [x] 检查 `npm ls --workspaces --depth=0` 与 `npm pack --dry-run --workspaces` 的发布包名和文件清单。
- [x] 审查最终 diff，并将结果写入 `test-results.md` 与 `review.md`。
