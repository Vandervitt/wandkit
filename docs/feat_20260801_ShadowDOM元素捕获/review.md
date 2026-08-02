# Shadow DOM 元素捕获复审记录

- 日期：2026-08-01
- 审查范围：`main @ 5dbb4c4` 至 `feat_20260801_ShadowDOM元素捕获 @ 2944447`

## 需求与设计覆盖

| 检查项 | 状态 | 证据与结论 |
| --- | --- | --- |
| 私有架构边界 | 通过 | `composedTree.ts` 只被 executor 内部引用，未从 `packages/executor/src/index.ts` 导出，公开 API 不变 |
| open Shadow Root | 通过 | 深度优先遍历 Host 的 open Shadow Root，并覆盖嵌套 Root |
| slot 分发 | 通过 | 使用 `assignedNodes({ flatten: true })`，元素和文本均参与；有分发时不启用 fallback，未分发 light DOM 不进入结果 |
| 顺序与去重 | 通过 | composed tree 顺序遍历，单次遍历使用 `WeakSet<Node>` 去重 |
| closed Root 与 iframe | 通过 | 未读取 closed Root 内部，未访问 `contentDocument`/`contentWindow`，边界未扩大 |
| 异常降级 | 通过 | Host、slot 或 childNodes 读取异常时只跳过该节点内部，后续兄弟继续遍历 |
| 跨边界祖先 | 通过 | 隐藏、层级、交互祖先/后代、遮挡、行上下文和复合下拉统一使用 composed 关系 |
| Tree Scope | 通过 | `aria-labelledby` 与 `label[for]` 在元素所属 Document/ShadowRoot 查询；原生包裹式 label 不跨 Scope |
| composed text | 通过 | slot 分发文本可成为内部按钮名称；行、首格和表单错误读取 composed text |
| 索引与真实元素 | 通过 | `snapshotElements.push()` 与 `domElements.push()` 保持同一遍历、同一分支同步追加 |
| 控制器动作 | 通过 | 点击、输入、原生选择直接操作影子树真实元素；Host 移除后 `isConnected` 使旧索引失效 |
| 整页辅助扫描 | 通过 | 表单校验错误与最大滚动容器使用 composed tree 扫描 |

## 安全、性能与兼容性

| 维度 | 状态 | 结论 |
| --- | --- | --- |
| 凭据脱敏 | 通过 | `valueOf()`、密码/token/验证码识别和属性脱敏逻辑未被绕过；新遍历只改变候选来源 |
| 权限与外部接口 | 不涉及 | 未新增接口、权限入口、网络请求或数据库变更 |
| 性能 | 通过 | 遍历为惰性生成器；候选、后代和行扫描在命中后短路；度量仍复用既有 `MeasureCache` |
| 普通 DOM 兼容 | 通过 | executor 196/196、全仓 727/727 测试通过，普通顺序、层级、遮挡、下拉和滚动无回归 |
| 构建兼容 | 通过 | 所有 workspace TypeScript 检查和 tsup 构建通过 |

## 改动范围

| 类型 | 文件 |
| --- | --- |
| 新增私有实现 | `packages/executor/src/composedTree.ts` |
| 快照集成 | `packages/executor/src/snapshot.ts` |
| 控制器集成 | `packages/executor/src/controller.ts` |
| 测试 | `composedTree.spec.ts`、`snapshot.spec.ts`、`crossFramework.spec.ts`、`controller.spec.ts` |
| 文档 | 本分支 `docs/feat_20260801_ShadowDOM元素捕获/` |

未修改公开导出、依赖、构建配置、网络层、数据库或其他 package 的生产代码。

## 审查结论

- Critical：无。
- Important：无。
- Minor：无阻塞项。仓库尚无真实浏览器 Shadow DOM E2E 夹具，已在测试结果中记录为后续可选增强。
- Ready to merge：是。实现与已批准设计一致，边界明确，红绿回归和全仓验证均有本轮证据。
