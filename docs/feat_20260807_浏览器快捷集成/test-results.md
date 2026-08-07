# 浏览器快捷集成测试结果

日期：2026-08-07

分支：`feat_20260807_浏览器快捷集成`

## TDD 回归记录

| 场景 | 红灯证据 | 绿灯结果 |
|---|---|---|
| 显式请求跟踪 | `startRequestTracking is not a function` | 请求发起前即可安装 tracker |
| busy 状态停止按钮 | 发送按钮仍为 disabled | `panel.spec.ts` 34 项通过 |
| 基础快捷挂载 | `mountWandkit is not a function` | dock/panel、标题和消息闭环通过 |
| 工具历史与 UI 控制 | tool_calls 缺失，stop/clear 调用数为 0 | 历史配对、停止和新会话通过 |
| 写请求拒绝闭环 | 等待不到确认卡 | 请求未发送，工具结果 `cancelled: true` |
| LLM 精确放行 | LLM 悬挂时业务 POST 被错误 resolve | 只匹配 `llmRequest`，业务写请求仍拒绝 |
| 快照隔离 | 快照包含“打开助手（执行中）” | dock/panel/确认卡/mask 均被排除 |
| 销毁悬挂确认 | 销毁后旧卡片仍能批准并发出请求 | AbortSignal 从严拒绝当前及排队确认 |
| Tracker 租约 | `startRequestTracking()` 返回 `undefined` | 引用计数，最后一个租约释放才卸载 |
| Patch 身份恢复 | 外层 Fetch/XHR/history wrapper 被覆盖 | 仅当前引用仍是自身 patch 时恢复 |
| 规范化工具历史 | 兼容 content 路径产生孤立 tool 消息 | Runtime 事件携带规范化 `toolCalls` |
| stop 历史回滚 | 导出残留 user + 未配对 tool_calls | Runtime/ChatSession 同步回滚安全点 |
| 重复发送 | 活动 Run 中第二次 send 覆盖安全点 | 重复 send 被 bridge 忽略 |
| 预装 tracker | 错误 patch 顺序仍继续 mount | 明确拒绝并回滚本次资源 |
| 安装异常清理 | interceptor 抛错后 history patch 残留 | 初始化清理栈逆序释放全部已获资源 |

## 针对性验证

```text
npm test -- packages/browser/src/mountWandkit.spec.ts \
  packages/executor/src/snapshot.spec.ts \
  packages/executor/src/routeWatcher.spec.ts \
  packages/chat/src/panel.spec.ts
```

最终相关用例已纳入下述全仓验证；browser、route watcher、chat bridge 分别为 13、15、24
项测试。

```text
npm test -- packages/browser/src/mountWandkit.spec.ts \
  packages/interceptor/src/confirmUi.spec.ts
```

上述确认 UI 与 browser 组合用例均纳入全仓验证。

## 全仓验证

执行：

```text
npm run verify
```

结果：退出码 0。

| 层级 | 结果 |
|---|---|
| Vitest | 59 个测试文件、888 项测试全部通过 |
| TypeScript | browser、chat、core、executor、interceptor、ui 及 page-agent eval 类型检查通过 |
| Build | 6 个 workspace 的 ESM、CJS 和声明文件构建通过 |
| 包发布检查 | `npm pack --dry-run --workspace @wandkit/browser` 包含 README、dist 与 package.json |

非阻塞输出：Vitest 提示 `environmentMatchGlobs` 已弃用；jsdom 在三项既有表单测试中提示
`HTMLFormElement.requestSubmit()` 未实现。相关用例仍通过，本次未扩大范围处理既有告警。

## 后续集成验证

本仓库验证只覆盖快捷包及组合契约。真实 Vue 2 / Element UI 宿主、线上 dev 后端和浏览器
用户链路将在 `aicc-admin-front` 通过 `npm link --no-save` 接入后执行 E2E。
