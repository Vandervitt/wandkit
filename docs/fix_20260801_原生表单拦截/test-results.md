# 原生表单拦截测试结果

分支：`fix_20260801_原生表单拦截`

基线：`main` @ `80dbf41`

验证日期：2026-08-01（Asia/Shanghai）

## TDD 红绿记录

所有生产行为均在对应回归测试失败后实现。关键红相位如下：

| 行为 | 红相位证据 | 绿相位结果 |
|---|---|---|
| 显式 form 通道安装 | `event.defaultPrevented` 期望 `true`、实际 `false` | 原生 submit 被暂停并在批准后重放 |
| 直接 `form.submit()` | 批准前实际已调用底层 submit | 同步返回 `undefined`，批准后才调用 |
| `requestSubmit(submitter)` | 实际投影为 form 的 POST `/api/users` | 使用 submitter GET `/api/preview` 与字段 |
| POST 重复字段 | 实际 `{ tag: 'b' }` | 有序投影为 `{ tag: ['a', 'b'] }` |
| 文件字段 | 实际把 `File` 句柄交给策略 | 只保留 name/type/size/lastModified 元数据 |
| 等待期间字段变化 | 旧批准仍调用底层 submit | 快照变化后丢弃旧 continuation |
| `method=dialog` | submit 事件被 `preventDefault()` | 事件与直接 submit 均绕过网络闸门 |
| 多实例事件顺序 | 实际 `A → B → A` | 固定为 `B → A → browser`，只重放一次 |
| submitter 安全重放 | 重放丢失 override 和 submitter 字段 | 临时属性/hidden input 保留并在 finally 恢复 |
| 通道事务安装 | 监听失败后 `installed === true` | 逆序回滚全部已安装通道，恢复 false |
| 注册表冲突 | 不兼容外部值仍允许安装 | 从严拒绝、回滚且不覆盖外部值 |
| 底层 submit 抛错 | 异步链吞掉原异常 | 清理完成后通过 microtask 重新暴露原错误 |

执行方式为逐个 `npx vitest run packages/interceptor/src/form.spec.ts -t "<用例名>"`，每个
失败均确认由缺失行为造成，而非语法、测试设施或环境错误；修复后再运行对应定向用例和
完整 `form.spec.ts`。

## 最终自动化验证

### Form 定向测试

```bash
npx vitest run packages/interceptor/src/form.spec.ts
```

结果：1 个测试文件通过，40/40 用例通过，退出码 0。

### Interceptor 包测试

```bash
npx vitest run packages/interceptor/src
```

结果：8 个测试文件通过，172/172 用例通过，退出码 0。

### Interceptor 类型检查

```bash
npm run typecheck --workspace @toolairlock/interceptor
```

结果：`tsc --noEmit` 退出码 0。

### Workspace 完整门槛

```bash
npm run verify
```

结果：

- 全仓测试：47 个测试文件通过，702/702 用例通过。
- 所有 workspace 类型检查通过。
- `@toolairlock/chat`、`toolairlock`、`@toolairlock/executor`、
  `@toolairlock/interceptor`、`@toolairlock/ui` 构建通过。
- 命令退出码 0。

全仓测试仍输出 3 条既有 jsdom stderr：
`Not implemented: HTMLFormElement's requestSubmit() method`，来自
`packages/executor/src/tools.spec.ts`。对应用例和完整测试均通过；本次新增
`packages/interceptor/src/form.spec.ts` 没有该 stderr。

### Diff 检查

```bash
git diff --check
git diff --check main...HEAD
```

结果：均无输出，退出码 0。

## 真实浏览器冒烟

目标流程：原生 GET/POST、`requestSubmit(submitter)`、SPA `preventDefault()` → form
闸门判定 → 批准后原生重放或 SPA 跳过。

环境分类：Browser 插件不可用；仓库未安装普通 Playwright。

```bash
npm ls @playwright/test playwright playwright-core --all --depth=0
npx --no-install playwright --version
```

结果：依赖树为空；第二条命令明确因缺少 `playwright@1.62.1` 而取消，退出码均为 1。
按约束未安装新依赖，因此真实浏览器冒烟跳过，没有生成截图、trace 或日志目录，也没有
启动本地服务器或遗留进程。
