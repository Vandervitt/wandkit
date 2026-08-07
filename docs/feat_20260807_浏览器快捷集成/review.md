# 浏览器快捷集成自审

日期：2026-08-07

结论：三轮独立审查发现的 Critical / Important 均已修复；最终 `npm run verify` 通过，
可以提交并进入真实宿主接入验证。

## 审查清单

| 项目 | 结果 | 说明 |
|---|---|---|
| 公共 API | 通过 | `mountWandkit()` 只要求宿主提供 LLM、权限读取和拦截策略 |
| 安装顺序 | 通过 | interceptor 先安装，request tracker 后安装并位于外层 |
| 页面动作遮罩 | 通过 | `page_read` 不遮罩，其余四类动作完整遮罩 |
| 请求拒绝 | 通过 | Fetch/XHR 拒绝被投影为工具取消，禁止误报成功 |
| LLM 请求 | 通过 | 精确 `llmRequest` matcher 放行代理；异步等待期间没有全局授权窗口 |
| OpenAI 历史 | 通过 | Runtime 事件携带规范化 tool calls；取消时 Runtime/Chat 同步回滚 |
| Tracker 生命周期 | 通过 | 租约引用计数，最后一个使用者释放才 identity-aware 还原 |
| 预装 Tracker | 通过 | 检测到位于 interceptor 内层时拒绝 mount，并回滚本次资源 |
| 并发发送 | 通过 | bridge 在 Run 活动期间忽略重复 send，不覆盖会话安全点 |
| History 生命周期 | 通过 | 仅当全局引用仍是自身 wrapper 时恢复 |
| 初始化失败清理 | 通过 | cleanup stack 逆序释放 controller、controls、interceptor、tracker 等资源 |
| 自身 UI 隔离 | 通过 | 快照排除 dock、panel、确认卡和 mask 的 composed tree |
| 确认队列销毁 | 通过 | AbortSignal 同时拒绝当前及排队中的确认 |
| 幂等销毁 | 通过 | 重复调用安全，还原 Fetch/XHR/history 并移除 UI |
| 文档 | 通过 | 根 README、browser README、chat/interceptor README 已同步 |

## 关键实现判断

1. 快捷层保持框架无关，只使用 DOM、Web Components 和宿主注入的 `LlmClient`。
2. 页面原语继续声明为 read，真实写风险由请求拦截器在网络层判定；拒绝结果用结构化
   `cancelled` 标记参与 Runtime 控制流。
3. 使用 executor 通用 `exclude` 谓词隔离自身 UI，没有在快照层写死 Wandkit 标签；
   browser 只负责提供对应谓词。
4. 销毁确认采用通用 handler 的 AbortSignal，而不是只查找并点击当前卡片，因此并发请求
   队列也能完整收尾。
5. LLM 代理只能通过精确 matcher 放行；粗粒度 authorization scope 只适合已确认、已评审
   的声明式工具执行，不适合包裹任意异步 transport。
6. 预存 tracker 无法在不理解未知 patch 栈的前提下安全重排，因此首版选择显式拒绝挂载，
   而不是让确认等待漏计并提前回报页面稳定。

## 已知边界

- 首版只支持同一 Window 一个活动实例；多个实例会争用浏览器全局 patch。
- 宿主需先释放自己预装的 tracker，再调用 `mountWandkit()`。
- WebSocket / SSE 不在 interceptor 当前覆盖范围内。
- 宿主必须把模型调用放在后端代理，浏览器包不持有模型凭据。
- 真实宿主的路由、权限格式、POST 查询放行规则和 E2E 结果需在 AICC 接入阶段核实。
