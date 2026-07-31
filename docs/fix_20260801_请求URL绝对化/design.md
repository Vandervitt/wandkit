# 请求 URL 绝对化设计

分支：`fix_20260801_请求URL绝对化`

基线：`main` @ `ce191bd`

## 问题

`InterceptedRequest.url` 的公开契约声明 URL 已解析为绝对形式，但 Fetch 字符串参数、
`XMLHttpRequest.open()` 和 `navigator.sendBeacon()` 当前把相对 URL 原样交给策略层。

策略层对以 `/` 开头的规则只比较 pathname，因此常见路径规则不受影响；但带协议的规则
会比较完整 URL。若危险 GET 只按完整 origin 配置，相对请求无法命中危险名单，随后会被
`safe_method` 分支直接放行。这既违反公开契约，也形成安全策略缺口。

## 根因

四个请求通道的快照入口没有共享 URL 不变式：

| 通道 | 当前行为 | 是否绝对化 |
|---|---|---|
| Fetch 字符串/URL | `String(input)` | 否 |
| Fetch Request | `request.url` | 是（浏览器保证） |
| XHR | `String(url)` | 否 |
| Beacon | `String(url)` | 否 |
| Form | `new URL(value, document.baseURI).href` | 是 |

表单通道已经提供了同仓可工作的参考实现，说明应在生成纯数据快照时解析 URL，而不是
改写原生 API 的入参。

## 方案

在 `packages/interceptor/src/interceptor.ts` 增加私有 URL 解析函数：

```ts
function resolveRequestUrl(
  view: Window & typeof globalThis,
  value: string | URL
): string {
  return new view.URL(String(value), view.document.baseURI).href
}
```

Fetch、XHR 和 Beacon 在构造 `InterceptedRequest` 时调用该函数。Fetch 的请求解析函数
显式接收当前 `view`，确保 iframe/注入 Window 使用自己的 URL 构造器和文档基址。

原始 `fetch`、`XMLHttpRequest.open` 和 `sendBeacon` 调用仍透传调用方原参数；绝对化只
影响策略匹配、确认披露和 trace 中的请求快照。

## 安全与兼容性

- 完整 origin 的危险规则能稳定命中相对请求，尤其避免危险 GET 被安全方法短路放行。
- pathname 规则继续从绝对 URL 中提取 pathname，现有 `/api/**` 配置语义不变。
- `<base href>` 会参与解析，与浏览器对相对网络地址的解析基址保持一致。
- 畸形 URL 的解析错误不会被吞掉；原生网络 API 对同类输入本来也会失败，闸门不会在
  无法形成可信快照时放行请求。
- 不修改公开类型、策略顺序、确认行为、通道默认值或原生调用参数。

## 验证矩阵

| 场景 | 预期 |
|---|---|
| Fetch 相对危险 GET + 完整 URL 规则 | 命中 `destructive`，拒绝时不发送 |
| XHR 相对危险 GET + 完整 URL 规则 | 命中 `destructive`，拒绝时不发送 |
| Beacon 相对 URL + 完整 URL allow 规则 | 命中 allow 并同步透传 |
| 三通道原生调用参数 | 仍保持调用方传入的相对 URL |
| 全仓验证 | 测试、类型检查、构建全部通过 |
