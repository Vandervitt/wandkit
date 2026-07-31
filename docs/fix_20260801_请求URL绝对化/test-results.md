# 请求 URL 绝对化测试结果

分支：`fix_20260801_请求URL绝对化`

基线：`main` @ `ce191bd`

## 红测证据

命令：

```bash
npx vitest run packages/interceptor/src/interceptor.spec.ts packages/interceptor/src/channels.spec.ts
```

修复前结果：退出码 `1`，2 个测试文件中 5 个用例失败、52 个通过。

| 失败用例 | 证明的问题 |
|---|---|
| Fetch 相对危险 GET | Promise 实际 resolve，完整 URL 危险规则未命中 |
| XHR 相对危险 GET | confirm 调用次数为 0，安全方法被直接放行 |
| XHR 既有快照断言 | 实际 URL 仍为 `/api/users/u_1` |
| Beacon 完整 URL allow | 返回 `false`，完整地址放行规则未命中 |
| Beacon 既有快照断言 | 实际 URL 仍为 `/api/track` |

红测失败原因与根因一致，不是测试语法、环境或夹具错误。

## 目标测试转绿

命令：

```bash
npx vitest run packages/interceptor/src/interceptor.spec.ts packages/interceptor/src/channels.spec.ts
```

结果：退出码 `0`。

- 2 个测试文件通过。
- 57/57 测试通过。
- Fetch/XHR 危险 GET 均命中 `destructive`，拒绝后底层未发送。
- Beacon 完整 URL allow 规则命中，底层仍收到调用方原始相对 URL。

## Interceptor 分层验证

命令：

```bash
npx vitest run packages/interceptor/src
```

结果：退出码 `0`。

- 8 个测试文件通过。
- 175/175 测试通过。

## 全仓验证

命令：

```bash
npm run verify
```

结果：退出码 `0`。

- 47 个测试文件通过。
- 705/705 测试通过。
- 所有 workspace 类型检查通过。
- 所有 workspace 构建通过。
- `packages/executor/src/tools.spec.ts` 仍有 3 条既有 jsdom
  `HTMLFormElement.requestSubmit()` 未实现提示；相关测试通过，与本修复无关。

## 静态检查

```bash
git diff --check
```

结果：退出码 `0`，未发现空白错误。
