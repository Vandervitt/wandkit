# 正则规则状态污染测试结果

执行日期：2026-07-31

## 基线

生产代码和测试尚未修改时执行：

```bash
npm test -- packages/interceptor/src/policy.spec.ts
```

结果：退出码 0，1 个测试文件、30 个测试全部通过。

## 根因最小复现

使用 Node.js 对相同 URL 连续执行状态型正则：

```text
g: true(lastIndex=34) → false(lastIndex=0) → true(lastIndex=34)
y: true(lastIndex=33) → false(lastIndex=0)
```

以相同 `source` 与 `flags` 创建一次性副本后，`g`/`y` 均连续三次返回 `true`，原规则
`lastIndex` 保持 0。

## TDD 红灯

只增加 4 个回归测试后执行：

```bash
npx vitest run packages/interceptor/src/policy.spec.ts
```

结果：退出码 1，34 个测试中新增 4 个全部按预期失败：

1. `g` 危险规则连续三次判定得到 `danger_list, default_deny, danger_list`。
2. `y` 危险规则连续三次判定得到 `danger_list, default_deny, danger_list`。
3. `g` 正则单次判定后 `lastIndex` 从 0 变为 34。
4. `y` 正则单次判定后 `lastIndex` 从 0 变为 33。

失败同时证明判定结果会间歇性降级，且策略引擎修改了调用方的规则对象。

## TDD 绿灯

状态型正则改为在一次性副本上匹配后执行同一命令：

```bash
npx vitest run packages/interceptor/src/policy.spec.ts
```

结果：退出码 0，1 个测试文件、34 个测试全部通过。

## Interceptor 包级验证

执行：

```bash
npx vitest run packages/interceptor/src
npm run typecheck --workspace @toolairlock/interceptor
```

结果：退出码均为 0。

- Vitest：7 个测试文件、119 个测试全部通过。
- TypeScript：`@toolairlock/interceptor` 的 `tsc --noEmit` 通过。

## 完整验证

执行：

```bash
npm run verify
```

结果：退出码 0。

- Vitest：46 个测试文件、649 个测试全部通过。
- TypeScript：5 个 workspace 的 `tsc --noEmit` 全部通过。
- Build：5 个 workspace 的 tsup ESM、CJS、DTS 构建全部通过。
- 测试输出包含 jsdom 对 `HTMLFormElement.requestSubmit()` 未实现的既有 stderr 提示，
  对应测试通过，不属于本次改动。

## 发布前检查

```bash
git diff --check
```

结果：退出码 0，无输出。
