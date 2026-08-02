# 网页任务完成率基线设计

> 分支：`test_20260802_网页任务完成率基线`
> 状态：已批准方向下的第一阶段实施

## 1. 目标

在实现 `PageAgentRuntime` 之前，建立一套可重复运行、可比较不同 Runner 和模型的网页任务评估基线。评估以页面最终状态和最终回答为准，不以“调用了某个工具”代替任务成功。

本分支只建设评估设施并测量当前 `AgentRuntime + createPageTools + PAGE_AGENT_SYSTEM_PROMPT`，不实现新的 Agent 循环，不修改既有页面动作语义。

## 2. 范围

首批场景覆盖：

| 类别 | 场景 | 成功判据 |
|---|---|---|
| 读取数据 | 读取页面统计数字 | 最终回答包含页面真实数字 |
| 跨页导航 | 从首页进入目标页面 | URL 与目标标题同时匹配 |
| 搜索筛选 | 输入条件并触发查询 | 结果区只保留目标记录 |
| 普通表单 | 填写并提交表单 | 新记录出现在列表中 |
| 复合下拉 | 操作非原生下拉 | 表单值变为目标选项 |
| 富文本 | 写入 `contenteditable` | 编辑区文本等于目标内容 |
| 校验修正 | 首次提交失败后修正 | 错误消失且记录创建成功 |
| 异步加载 | 等待延迟内容出现 | 最终回答包含异步结果 |
| 用户澄清 | 缺少必要信息 | Runner 产生明确追问，且不伪造输入 |
| 动态 DOM | 动作后元素整体替换 | 使用新页面状态完成后续动作 |

## 3. 架构

```text
Playwright Test
  ├─ 打开 Vite 场景站点
  ├─ 选择 EvalScenario
  ├─ LegacyRuntimeRunner
  │    ├─ AgentRuntime
  │    ├─ createPageTools
  │    └─ Fake/Real OpenAI-compatible LLM
  ├─ 页面成功判据
  └─ EvalAttempt → summarizeAttempts → JSON/Markdown 报告
```

评估层与 Runtime 解耦。后续新增 `PageAgentRuntimeRunner` 时复用同一组场景、判据和统计逻辑，确保对比口径一致。

## 4. 数据契约

```ts
export type EvalCategory =
  | 'read_data'
  | 'navigation'
  | 'search_filter'
  | 'form'
  | 'composite_select'
  | 'rich_text'
  | 'validation_recovery'
  | 'async_loading'
  | 'ask_user'
  | 'dynamic_dom'

export type EvalFailureCode =
  | 'model_protocol'
  | 'observation_miss'
  | 'stale_index'
  | 'action_no_effect'
  | 'unsupported_control'
  | 'validation_error'
  | 'waiting_timeout'
  | 'user_input_required'
  | 'repeated_action'
  | 'task_incomplete'
  | 'runtime_error'

export interface EvalAttempt {
  scenarioId: string
  category: EvalCategory
  runner: string
  model?: string
  passed: boolean
  falseSuccess: boolean
  durationMs: number
  steps: number
  promptTokens?: number
  completionTokens?: number
  failureCode?: EvalFailureCode
  failureMessage?: string
}
```

`falseSuccess` 表示 Runner 对用户宣称成功，但页面判据未成立。它必须与普通失败分开统计。

## 5. 运行方式

```bash
# 确定性浏览器回归，不需要 Key
npm run eval:page-agent

# 真实模型基线，读取现有 .env，并由本地代理持有 Key
npm run eval:page-agent:real
```

Playwright 产物统一写入：

```text
.playwright/网页任务完成率基线-20260802/
```

结果报告写入该目录的 JSON 与 Markdown，不进入 Git。经人工核实后的摘要追加到本分支 `test-results.md`。

## 6. 安全和隐私边界

- 浏览器测试不直接持有厂商 API Key，真实模型请求继续经过本地代理。
- Git 中只保存场景定义、判据和聚合结果格式，不保存模型原始请求、响应或页面敏感内容。
- 自动化报告只记录场景 ID、模型名、步骤、耗时、token 与失败分类。
- 本分支不处理 `npm audit` 报告的既有依赖漏洞，避免扩大范围。

## 7. 验收标准

- 确定性场景能证明“页面成功”和“Runner 自称成功”是两个独立维度。
- 同一场景可由旧 Runtime 和未来 PageAgentRuntime 共用。
- 真实模型测试缺少 Key 时明确失败，不静默当作通过。
- `npm run eval:page-agent`、`npm run verify` 均通过。
- 结果报告包含总体成功率、各类别成功率、假成功率、P50/P95 步骤数和耗时。
