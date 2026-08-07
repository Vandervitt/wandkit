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

浏览器宿主可直接使用快捷集成包：

```ts
import { mountWandkit } from '@wandkit/browser'

const app = mountWandkit({
  llm,
  heading: 'Admin Copilot',
  getPermissions,
  interception: {
    llmRequest: { method: 'POST', url: '/api/llm/chat' },
    policy
  }
})

app.destroy()
```

详细的安全默认值、生命周期和本地 `npm link` 方式见
[`packages/browser/README.md`](packages/browser/README.md)。

## Monorepo 结构

| 路径 | npm 包 / 用途 |
| --- | --- |
| [`packages/core`](packages/core) | `wandkit`：Agent Runtime、工具契约、确认和轨迹 |
| [`packages/executor`](packages/executor) | `@wandkit/executor`：通用 DOM 操作与页面控制 |
| [`packages/interceptor`](packages/interceptor) | `@wandkit/interceptor`：请求级写操作拦截与授权 |
| [`packages/chat`](packages/chat) | `@wandkit/chat`：会话状态、聊天面板和 Runtime bridge |
| [`packages/ui`](packages/ui) | `@wandkit/ui`：确认卡片和交互遮罩 |
| [`packages/browser`](packages/browser) | `@wandkit/browser`：Runtime、页面执行、聊天 UI 与请求治理的一调用集成 |
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
- [`packages/browser/README.md`](packages/browser/README.md)：浏览器快捷集成、安全默认值与本地链接。
- [`examples/README.md`](examples/README.md)：可运行示例和本地模型配置。
- [`docs/test_20260802_网页任务完成率基线/design.md`](docs/test_20260802_网页任务完成率基线/design.md)：评估设计与验收标准。

## License

[MIT](LICENSE)
