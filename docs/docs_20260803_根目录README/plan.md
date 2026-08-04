# 根目录 README Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新建根目录 `README.md`，向开发者准确介绍 Wandkit 的现有能力、快速开始、Monorepo 结构和网页任务完成率基线。

**Architecture:** README 只承担项目首页和索引职责，细节继续由各包 README 和 `docs/` 专项文档维护。先将本轮已验证的 GLM-5.2 结果追加到 tracked 测试记录，再由根 README 引用该事实源，避免依赖 ignored 的 `.playwright/` 产物。

**Tech Stack:** Markdown、npm scripts、Vitest、Playwright、Git

---

## 文件映射

- Modify: `docs/test_20260802_网页任务完成率基线/test-results.md`
  - 作为 GLM-5.2 基线结果的 tracked 事实源。
- Create: `README.md`
  - 承担项目定位、快速开始、包索引、评估摘要和文档导航。
- Reference only: `package.json`
  - 提供 Node.js 版本、workspace 和 npm scripts 的单一事实源。
- Reference only: `evals/page-agent/scenarios.ts`
  - 提供 10 个网页任务场景。
- Reference only: `evals/page-agent/site/scenarioRegistry.ts`
  - 提供页面状态和最终回答的程序化判定。

### Task 1: 将 GLM-5.2 结果纳入 tracked 测试记录

**Files:**
- Modify: `docs/test_20260802_网页任务完成率基线/test-results.md`
- Reference: `.playwright/网页任务完成率基线-20260802/legacy-real-glm-5.2-20260803T074107360Z-summary.md`
- Reference: `.playwright/网页任务完成率基线-20260802/legacy-real-glm-5.2-20260803T074107360Z-attempts.json`

- [ ] **Step 1: 核对原始报告 metadata 和汇总数据**

Run:

```bash
sed -n '1,90p' '.playwright/网页任务完成率基线-20260802/legacy-real-glm-5.2-20260803T074107360Z-summary.md'
sed -n '1,35p' '.playwright/网页任务完成率基线-20260802/legacy-real-glm-5.2-20260803T074107360Z-attempts.json'
```

Expected:

- Run ID 为 `20260803T074107360Z`。
- revision 为 `9073b2a069840010ac3dca99aee71e86ff3d01bb`，`gitDirty=false`。
- model 为 `glm-5.2`，30 次尝试通过 27 次，成功率 `90.00%`，假成功率 `0.00%`。
- `rich_text` 是唯一失败类别，3 次均为 `unsupported_control`。

- [ ] **Step 2: 在真实模型全矩阵部分后追加 GLM-5.2 复测摘要**

在 `## 6. 本任务验证` 之前插入：

```markdown
### 5.1 GLM-5.2 高级模型复测

为验证成功率上限，在同一代码与场景矩阵上使用 `glm-5.2`
重跑 10 个场景、每场景 3 次：

| 项目 | 结果 |
| --- | --- |
| Run ID | `20260803T074107360Z` |
| revision / dirty | `9073b2a069840010ac3dca99aee71e86ff3d01bb` / `false` |
| model | `glm-5.2` |
| attempts | 10 个场景各 3 次，共 30 次 |
| 通过 | 27 / 30 |
| 成功率 | 90.00% |
| 假成功率 | 0.00% |
| P50 / P95 步骤数 | 3 / 16 |
| P50 / P95 耗时 | 24879 ms / 126306 ms |
| 唯一失败项 | `rich_text` 0 / 3，均为 `unsupported_control` |

分类结果中，除 `rich_text` 外的 9 个类别均为 3 / 3。这表明
高级模型已将当前基线提升到 90%，但 `contenteditable` 仍是执行层的
结构性缺口，不应通过 prompt 逐例规则规避。
```

- [ ] **Step 3: 验证记录中的关键数据**

Run:

```bash
rg -n "20260803T074107360Z|glm-5\.2|27 / 30|90\.00%|unsupported_control" 'docs/test_20260802_网页任务完成率基线/test-results.md'
git diff --check
```

Expected: 两条命令退出码均为 0，所有关键数据都能匹配，无空白错误。

- [ ] **Step 4: 提交基线事实源更新**

```bash
git add 'docs/test_20260802_网页任务完成率基线/test-results.md'
git commit -m 'docs: 记录 GLM-5.2 网页基线结果'
```

### Task 2: 新建项目根 README

**Files:**
- Create: `README.md`
- Reference: `package.json`
- Reference: `packages/core/README.md`
- Reference: `packages/interceptor/README.md`
- Reference: `packages/chat/README.md`
- Reference: `examples/README.md`

- [ ] **Step 1: 验证根 README 当前不存在**

Run:

```bash
test ! -e README.md
```

Expected: 退出码为 0，证明这是新建文件，不会覆盖现有项目首页。

- [ ] **Step 2: 创建以下 `README.md`**

```markdown
# Wandkit

> 面向 in-app LLM Agent 的运行时、网页执行、写操作治理与评估工具集。

Wandkit 是一个 TypeScript Monorepo，用于将 Agent Runtime、通用 DOM 操作、
请求级安全闸门、聊天 UI 和可重复的网页任务评估组合到同一套工程体系中。

> npm 发布包统一使用 `wandkit` / `@wandkit/*` namespace。

## 核心能力

- **Agent Runtime**：工具发现、调度、结构化轨迹、失败建模和人工确认。
- **网页执行**：基于可访问性语义的 DOM 读取与 click、input、select、scroll 等通用动作。
- **写操作治理**：风险分级、两阶段写入、TOCTOU 复核、请求拦截和审计。
- **会话与 UI**：无头会话状态、OpenAI chat-completions 协议和可选 Web Components。
- **评估基础设施**：确定性与真实模型网页任务矩阵、假成功检测、失败分类和报告。

## 快速开始

要求 Node.js 18 或更高版本。

```bash
npm install
npm run verify
```

`npm run verify` 会依次运行 Vitest、TypeScript 类型检查和所有 workspace 构建。

可从确定性示例开始了解执行与治理链路：

```bash
npm run example
```

更多示例见 [`examples/README.md`](examples/README.md)。

## Monorepo 结构

| 路径 | npm 包 / 用途 |
| --- | --- |
| [`packages/core`](packages/core) | `wandkit`：Agent Runtime、工具契约、确认和轨迹 |
| [`packages/executor`](packages/executor) | `@wandkit/executor`：通用 DOM 操作与页面控制 |
| [`packages/interceptor`](packages/interceptor) | `@wandkit/interceptor`：请求级写操作拦截与授权 |
| [`packages/chat`](packages/chat) | `@wandkit/chat`：会话状态、聊天面板和 Runtime bridge |
| [`packages/ui`](packages/ui) | `@wandkit/ui`：确认卡片和交互遮罩 |
| [`evals/page-agent`](evals/page-agent) | 网页任务完成率基线与报告 |
| [`examples`](examples) | 确定性、真实模型、页面执行和聊天示例 |

## 网页任务完成率基线

当前基线使用 10 个可程序化判定的网页任务：

| 场景 | 覆盖能力 |
| --- | --- |
| `read-data` | 读取页面数据并准确回答 |
| `navigation` | 跨页面导航 |
| `search-filter` | 搜索与列表筛选 |
| `form` | 普通表单填写与提交 |
| `composite-select` | 复合下拉选择 |
| `rich-text` | `contenteditable` 富文本输入 |
| `validation-recovery` | 校验失败后修正并重试 |
| `async-loading` | 异步加载与等待 |
| `ask-user` | 缺少信息时追问用户 |
| `dynamic-dom` | 动态 DOM 替换后重新观察和操作 |

运行确定性基线：

```bash
npm run eval:page-agent
```

真实模型评估仅允许通过 loopback 本地代理访问模型，避免在浏览器中暴露 API key。启动代理后运行：

```bash
PAGE_AGENT_EVAL_REAL_ENDPOINT=http://127.0.0.1:8788/llm/chat \
PAGE_AGENT_EVAL_REAL_MODEL=glm-5.2 \
PAGE_AGENT_EVAL_REAL_ATTEMPTS=3 \
npm run eval:page-agent:real
```

在 revision `9073b2a` 上，`glm-5.2` 对 10 个场景各运行 3 次：

| 指标 | 结果 |
| --- | ---: |
| 总尝试数 | 30 |
| 通过 | 27 |
| 成功率 | **90.00%** |
| 假成功率 | 0.00% |

唯一失败类别是 `rich-text`（3 次均为 `unsupported_control`），说明
`contenteditable` 仍是当前执行层的明确缺口。详细运行配置、分类结果和已知限制见
[网页任务完成率基线测试结果](docs/test_20260802_网页任务完成率基线/test-results.md)。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run test` | 运行 Vitest 测试 |
| `npm run typecheck` | 运行各 workspace 和网页评估的 TypeScript 检查 |
| `npm run build` | 构建所有 workspace |
| `npm run verify` | 依次执行 test、typecheck 和 build |
| `npm run eval:page-agent` | 运行确定性网页任务基线 |
| `npm run eval:page-agent:real` | 运行已显式启用的真实模型基线 |

## 文档

- [`packages/core/README.md`](packages/core/README.md)：Agent Runtime 与两阶段写入。
- [`packages/interceptor/README.md`](packages/interceptor/README.md)：请求拦截和授权治理。
- [`packages/chat/README.md`](packages/chat/README.md)：会话状态、UI 与 Runtime bridge。
- [`examples/README.md`](examples/README.md)：可运行示例和本地模型配置。
- [`docs/test_20260802_网页任务完成率基线/design.md`](docs/test_20260802_网页任务完成率基线/design.md)：评估设计与验收标准。

## License

[MIT](LICENSE)
```

- [ ] **Step 3: 校验 README 中使用的仓库路径和脚本**

Run:

```bash
test -f README.md
test -f package.json
test -f packages/core/README.md
test -f packages/interceptor/README.md
test -f packages/chat/README.md
test -f examples/README.md
test -f 'docs/test_20260802_网页任务完成率基线/test-results.md'
test -f LICENSE
rg -n '"verify"|"eval:page-agent"|"eval:page-agent:real"' package.json
rg -n 'npm run verify|npm run eval:page-agent|npm run eval:page-agent:real|27|90\.00%|rich-text' README.md
git diff --check
```

Expected: 所有命令退出码均为 0，README 引用的路径存在，脚本名与 `package.json` 一致，无空白错误。

- [ ] **Step 4: 提交根 README**

```bash
git add README.md
git commit -m 'docs: 新增项目根目录 README'
```

### Task 3: 最终验证与自审

**Files:**
- Verify: `README.md`
- Verify: `docs/test_20260802_网页任务完成率基线/test-results.md`
- Verify: `docs/docs_20260803_根目录README/design.md`
- Verify: `docs/docs_20260803_根目录README/plan.md`

- [ ] **Step 1: 运行项目完整验证**

Run:

```bash
npm run verify
```

Expected: Vitest、TypeScript 类型检查和各 workspace 构建全部退出 0。

- [ ] **Step 2: 运行文档一致性检查**

Run:

```bash
git diff --check main...HEAD
git status --short --branch
git log --oneline main..HEAD
```

Expected:

- `git diff --check` 退出 0。
- 工作区无未提交文件。
- 分支历史包含设计、计划、GLM-5.2 记录和根 README 的文档提交。

- [ ] **Step 3: 审查对外表述边界**

Run:

```bash
rg -n 'PageAgentRuntime|WandkitAgent|API[_ -]?key|90\.00%|unsupported_control' README.md
```

Expected:

- 不应出现将未实现的 `PageAgentRuntime` 或 `WandkitAgent` 宣传为现有产品的表述。
- API key 只出现在“不进浏览器”的安全说明中，不包含真实密钥。
- 90% 结果必须同时标注 model、revision、样本数和 `rich-text` 已知失败。
