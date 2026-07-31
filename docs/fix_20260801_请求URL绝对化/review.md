# 请求 URL 绝对化复审记录

分支：`fix_20260801_请求URL绝对化`

基线：`main` @ `ce191bd`

## 结论

复审未发现阻止提交的高置信度问题。实现修复了 `InterceptedRequest.url` 与公开契约不一致
的问题，并关闭了完整 origin 危险规则对相对安全方法失配的策略缺口。

## 改动与状态

| 文件 | 状态 | 复审结论 |
|---|---|---|
| `packages/interceptor/src/interceptor.ts` | 修改 | 三个非表单通道在快照边界统一绝对化 URL |
| `packages/interceptor/src/interceptor.spec.ts` | 修改 | 覆盖 Fetch 相对危险 GET 不再绕过 |
| `packages/interceptor/src/channels.spec.ts` | 修改 | 覆盖 XHR 危险 GET、Beacon 完整 URL allow 与参数透传 |
| `docs/fix_20260801_请求URL绝对化/design.md` | 新增 | 记录根因、契约、安全边界和方案 |
| `docs/fix_20260801_请求URL绝对化/plan.md` | 新增 | 记录 TDD 与交付步骤 |
| `docs/fix_20260801_请求URL绝对化/test-results.md` | 新增 | 记录红绿与全仓验证证据 |
| `docs/fix_20260801_请求URL绝对化/review.md` | 新增 | 记录规格、兼容性、安全和范围复审 |

## 契约核对

| 核对项 | 结果 | 说明 |
|---|---|---|
| URL 快照为绝对形式 | 通过 | Fetch、XHR、Beacon 基于当前 `document.baseURI` 解析 |
| 完整 origin 危险规则 | 通过 | 相对危险 GET 在 safe method 短路前命中 danger |
| pathname 规则 | 通过 | 策略仍从绝对 URL 提取 pathname，既有用例全过 |
| 原生参数透传 | 通过 | 原始 fetch/XHR/Beacon 继续收到调用方相对 URL |
| Window/iframe 归属 | 通过 | 使用注入 `view` 的 URL 构造器与文档基址 |
| 表单通道 | 未修改 | 已有绝对化实现和 40 个测试继续通过 |
| 公开 API | 未修改 | `src/index.ts`、`src/types.ts` 无 diff |
| 策略顺序 | 未修改 | danger/safe/allow/default 顺序保持原样 |

## 安全复审

- 修复发生在不可信请求进入策略层之前，保证 matcher、describe、confirm、trace 共享同一
  绝对 URL 事实源。
- 危险 GET 不再因完整地址规则失配而落入 `safe_method` 放行分支。
- 没有扩大 allow 规则语义；带协议规则仍整体锚定，路径规则仍只比较 pathname。
- URL 无法解析时不会退回相对字符串继续判定，避免在事实不完整时静默放行。
- 不接触请求 body、headers、授权窗口、归属判定或确认 UI。

## 兼容性与范围

- 绝对化仅改变策略快照、披露和 trace 中的 URL 表示，不改变底层网络调用参数。
- 多实例包装会重复解析已绝对化 URL，但结果幂等；既有多实例和卸载测试全部通过。
- 未新增依赖、公开导出、构建配置、数据库脚本或跨 package 契约。
- 改动范围只包含 interceptor 生产代码、对应测试和本分支过程文档。
