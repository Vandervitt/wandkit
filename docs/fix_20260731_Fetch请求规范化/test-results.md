# Fetch 请求规范化测试结果

执行日期：2026-07-31

## 环境基线

切换回当前 `main` 基线后，本地 `node_modules` 链接和忽略的 `dist` 产物仍来自项目更名
分支。先执行 `npm install` 和 `npm run build`，恢复 `@toolairlock/*` workspace 链接并按
当前源码重建产物；Git 跟踪文件未因此改变。

随后执行：

```bash
npm test
```

结果：退出码 0，46 个测试文件、634 个测试全部通过。

## TDD 红灯

只加入回归测试、尚未修改生产代码时执行：

```bash
npx vitest run packages/interceptor/src/interceptor.spec.ts
```

结果：退出码 1，25 个测试中 4 个新增测试按预期失败：

1. Request 自带 body 未进入危险规则，宽泛 allow 规则直接放行。
2. 跨 realm Request 被降级为安全 GET，未进入确认。
3. Request clone 抛错未被触发，请求继续发送。
4. 策略读取到的 Request body 为 `undefined`。

## TDD 绿灯

完成最小实现后执行：

```bash
npx vitest run packages/interceptor/src/interceptor.spec.ts
```

结果：退出码 0，1 个测试文件、25 个测试全部通过。

## 自审补充红绿循环

使用真实 `Request` 构造验证发现：`init.body` 为 `undefined` 或 `null` 时，Fetch 会沿用
输入 Request 的 body。为防止 nullish init 再次造成 body 规则绕过，先增加两组参数化
回归测试并执行：

```bash
npx vitest run packages/interceptor/src/interceptor.spec.ts
```

红灯结果：退出码 1，27 个测试中新增 2 个失败，均表现为请求被宽泛 allow 规则放行。

改为仅让非 nullish `init.body` 覆盖 Request body 后重跑同一命令：退出码 0，27 个测试
全部通过。

根据独立代码审查补充 `clone().text()` 异步拒绝和原 fetch 严格透传断言后，再次执行目标
测试：退出码 0，28 个测试全部通过。

随后执行包级类型检查：

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

- Vitest：46 个测试文件、641 个测试全部通过。
- TypeScript：5 个 workspace 的 `tsc --noEmit` 全部通过。
- Build：5 个 workspace 的 tsup ESM、CJS、DTS 构建全部通过。
- 测试输出仍包含 jsdom 对 `HTMLFormElement.requestSubmit()` 未实现的既有 stderr 提示，
  对应测试通过，不属于本次改动。

## 发布前检查

```bash
git diff --check
```

结果：退出码 0，无输出。
