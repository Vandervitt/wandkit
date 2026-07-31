# XHR 确认竞态测试结果

执行日期：2026-07-31

## 基线

生产代码和测试尚未修改时执行：

```bash
npx vitest run packages/interceptor/src/channels.spec.ts
```

结果：退出码 0，1 个测试文件、11 个测试全部通过。

## TDD 红灯

只增加重新 `open()` 的两个回归测试后执行：

```bash
npx vitest run packages/interceptor/src/channels.spec.ts
```

结果：退出码 1，13 个测试中 2 个新增测试按预期失败：

1. 旧 DELETE 等待确认时改为新的 POST，批准旧请求后实际发送了新 POST 配置。
2. 使用相同 method/URL 重新 `open()`，批准旧请求后仍发生了一次发送。

两项失败均为 `sent` 期望长度 0、实际长度 1，证明旧 continuation 未与原 open 生命周期
绑定。

## TDD 绿灯

增加状态对象身份校验后执行同一命令：

```bash
npx vitest run packages/interceptor/src/channels.spec.ts
```

结果：退出码 0，1 个测试文件、13 个测试全部通过。

包级类型检查：

```bash
npm run typecheck --workspace @toolairlock/interceptor
```

结果：退出码 0。

## 完整验证

执行：

```bash
npm run verify
```

结果：退出码 0。

- Vitest：46 个测试文件、643 个测试全部通过。
- TypeScript：5 个 workspace 的 `tsc --noEmit` 全部通过。
- Build：5 个 workspace 的 tsup ESM、CJS、DTS 构建全部通过。
- 测试输出包含 jsdom 对 `HTMLFormElement.requestSubmit()` 未实现的既有 stderr 提示，
  对应测试通过，不属于本次改动。

## 发布前检查

```bash
git diff --check
```

结果：退出码 0，无输出。
