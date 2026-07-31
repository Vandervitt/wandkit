# 多实例卸载竞态测试结果

分支：`fix_20260731_多实例卸载竞态`
基线：`main` @ `3b7e145`

## 环境与依赖

执行：

```bash
npm install
```

结果：依赖已是最新状态，未修改 `package-lock.json`。npm 报告 4 个现有审计问题
（2 moderate、1 high、1 critical）；本修复不执行可能引入破坏性升级的
`npm audit fix --force`。

## 基线验证

执行：

```bash
npm test
```

结果：退出码 0；46 个测试文件、651 个测试全部通过。

## RED：Fetch 多实例

新增非 LIFO、LIFO 和外部 wrapper 用例后执行：

```bash
npx vitest run packages/interceptor/src/interceptor.spec.ts
```

结果：31 个测试中 2 个失败、29 个通过。

- 先卸载旧实例 A 后，请求直接到达基线 Fetch，B 的拒绝没有生效。
- A 后安装的外部 wrapper 被 A 的卸载覆盖。
- LIFO 用例通过，证明故障集中在非顶层卸载和外部边界，而非普通反向恢复。

## GREEN：Fetch 多实例

加入 patch 元数据、失活透传和安全恢复后执行：

```bash
npx vitest run packages/interceptor/src/interceptor.spec.ts
npm run typecheck --workspace @toolairlock/interceptor
git diff --check
```

结果：31 个测试全部通过；interceptor 类型检查和 diff 检查退出码 0。

## RED：XHR 与 Beacon 多实例

新增非 LIFO、失活旧引用和外部方法边界用例后执行：

```bash
npx vitest run packages/interceptor/src/channels.spec.ts
```

结果：22 个测试中 7 个失败、15 个通过。

- 旧 XHR/Beacon 实例卸载后，新实例被直接拆除。
- LIFO 卸载后的旧 XHR `send` 引用仍判定并吞掉发送。
- LIFO 卸载后的旧 Beacon 引用仍执行已卸载实例的 verdict。
- 外部只替换 XHR `open` 或 `send` 时，卸载都会覆盖外部方法。
- Beacon 后安装的外部 wrapper 同样会被覆盖。

## GREEN：XHR 与 Beacon 多实例

加入 XHR 分层 WeakMap、共享生命周期、同步失活透传和 Beacon 安全恢复后执行：

```bash
npx vitest run packages/interceptor/src/channels.spec.ts \
  packages/interceptor/src/interceptor.spec.ts
npm run typecheck --workspace @toolairlock/interceptor
git diff --check
```

结果：2 个测试文件、53 个测试全部通过；类型检查和 diff 检查退出码 0。

## RED/GREEN：异常外部元数据

主线程复审发现第三方同名 symbol 的 getter/Proxy 可能在卸载时抛错。先执行新增用例：

```bash
npx vitest run packages/interceptor/src/interceptor.spec.ts \
  -t "外部同名 patch 元数据读取抛错"
```

RED：1 个目标测试失败，实际抛出 `Error: metadata denied`。

在元数据读取边界加入异常隔离后重新执行目标测试、通道测试与类型检查：

```bash
npx vitest run packages/interceptor/src/interceptor.spec.ts \
  packages/interceptor/src/channels.spec.ts
npm run typecheck --workspace @toolairlock/interceptor
git diff --check
```

GREEN：2 个测试文件、54 个测试全部通过；类型检查和 diff 检查退出码 0。

## Interceptor 包完整测试

执行：

```bash
npx vitest run packages/interceptor/src
```

结果：退出码 0；7 个测试文件、132 个测试全部通过。

## 全仓最终门槛

执行：

```bash
npm run verify
git diff --check
```

结果：

- Vitest：46 个测试文件、662 个测试全部通过。
- Workspace TypeScript 类型检查：全部通过。
- Workspace tsup 构建：全部通过。
- `git diff --check`：无输出，退出码 0。
- executor 的 3 条 `HTMLFormElement.requestSubmit()` 信息是 jsdom 已知能力提示，对应测试
  均通过，不是本 PR 新增失败。

## 结论

全部验收路径已由失败回归测试证明旧行为，再由修复转绿。最终完整测试、类型检查、构建和
diff 检查均通过。
