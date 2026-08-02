# Shadow DOM 元素捕获设计

分支：`feat_20260801_ShadowDOM元素捕获`

基线：`main` @ `5dbb4c4`

## 1. 背景与目标

当前页面快照通过 `root.querySelectorAll(...)` 扫描单一 DOM Tree。`querySelectorAll` 不会
穿透 Shadow Root，因此 Web Components、Lit、Stencil 组件内部的按钮、输入框、正文和
滚动容器对 Agent 完全不可见。

仓库已有 P2 用例固定了现状：直接把 `ShadowRoot` 作为 `capturePage()` 的 root 时算法
可以工作，但从 `document` 抓取时不会主动进入影子树。这说明角色识别和动作执行不需要
重写，缺失的是 composed tree 的统一遍历与跨边界祖先语义。

本功能目标：

- 默认抓取 `document` 时穿透所有可访问的 open Shadow Root。
- 支持任意层级嵌套的 open Shadow Root。
- 按浏览器 composed tree 语义展开 `<slot>` 分发内容及 fallback 内容。
- 保持元素顺序、缩进层级、正文位置和动作索引一一对应。
- 让点击、输入、选择、显式索引滚动等现有动作直接作用于影子树中的真实元素。
- closed Shadow Root、iframe 保持不支持。

## 2. 方案比较

### 方案 A：独立 composed-tree 模块（采用）

新增私有模块集中提供遍历和祖先关系函数，`snapshot.ts` 与 `controller.ts` 复用。

优点：

- composed tree 语义只有一个事实源，不会在快照、可见性和控制器中各写一套。
- 可以单独测试 slot 顺序、嵌套根、去重和异常降级。
- 避免继续扩大已超过千行的 `snapshot.ts`。

代价：新增一个内部文件和一组私有接口。

### 方案 B：全部内联进 `snapshot.ts`（不采用）

文件数量少，但遍历、ARIA Tree Scope、可见性和格式化职责继续耦合，后续修复容易只改到
其中一条路径。

### 方案 C：分别扫描各 Shadow Root 后拼接（不采用）

实现最短，但影子树元素会被追加到整页末尾，破坏真实顺序、层级和正文归属；slot 分发
还会产生遗漏或重复，动作索引虽连续却不再表达页面结构。

## 3. 模块边界

新增 `packages/executor/src/composedTree.ts`，不从包公开入口导出。

它只负责 DOM 结构，不负责角色、可见性、格式化或动作：

```ts
export function composedChildNodes(root: ParentNode): readonly Node[]
export function composedElements(root: ParentNode): Iterable<Element>
export function composedTextContent(root: ParentNode): string
export function composedParent(element: Element): Element | null
export function composedContains(ancestor: Element, descendant: Element): boolean
export function closestComposed(element: Element, selector: string): Element | null
export function treeScope(element: Element): Document | ShadowRoot
```

`snapshot.ts` 继续负责：

- 可交互角色识别。
- 可见性、视口和遮挡判断。
- 可访问名、状态、正文、上下文和格式化。
- 快照元素与真实元素引用的同步产出。

`controller.ts` 继续负责：

- 保存快照索引到真实元素的映射。
- 点击、输入、选择和滚动。
- 动作前的索引、连接状态与页面跳转校验。

## 4. Composed Tree 遍历

### 4.1 基本顺序

使用深度优先、前序遍历。普通元素先产出自身，再处理它的渲染子树。传入的 root 自身
不进入结果，只遍历其渲染后代，保持现有 `root.querySelectorAll(...)` 的调用语义。

元素没有 Shadow Root 时，渲染子树是普通 `children`。

元素有 open Shadow Root 时，渲染子树改为 Shadow Root 的子节点；不直接遍历 Host 的
light DOM 子节点，因为未被 slot 分发的 light DOM 在真实页面上不会渲染。

### 4.2 Slot 分发

遍历到 `<slot>` 时：

1. 调用 `assignedNodes({ flatten: true })`，元素与文本节点都参与“slot 是否已有分发内容”
   的判断。
2. 有分发节点时，在 slot 所在位置依次遍历这些节点；元素继续递归，文本进入 composed
   text 计算。
3. 完全没有分发节点时，才遍历 slot 自己的 fallback 子树。

这保证：

- light DOM 元素出现在真实渲染位置，而不是 Host 原始子节点位置。
- 嵌套 slot 使用扁平分发结果。
- 只分发文本节点时不会错误启用 fallback。
- 未分发的 light DOM 不进入快照。
- 分发元素不会在 Host 下和 slot 下出现两次。

### 4.3 Composed Text

普通 `textContent` 不会把 slot 实际分发的文本投影进 Shadow DOM 内部控件。例如：

```html
<my-button>保存</my-button>
<!-- shadow: <button><slot></slot></button> -->
```

直接读取影子树中 `<button>` 的 `textContent` 得不到分发后的“保存”。因此模块提供
`composedTextContent()`，沿 `composedChildNodes()` 递归收集真实渲染文本。

可访问名、行上下文和正文读取在需要子树文本时使用 composed text；只需要元素自身直接
文本时，只读取 composed child nodes 中的直接 Text 节点，避免祖先层层重复整段内容。

### 4.4 去重与异常降级

单次遍历使用 `WeakSet<Node>` 去重，防止异常 slot 图或 DOM 实现返回重复节点。

读取某个 Host 的 `shadowRoot`、某个 slot 的 `assignedNodes` 或子节点时若抛异常：

- 只跳过该不可读取边界。
- 继续扫描同级和后续元素。
- 不让单个异常组件清空整页快照。

closed Shadow Root 的 `host.shadowRoot` 恒为 `null`，自然保持不可见，不尝试猴子补丁或
拦截 `attachShadow()`。

## 5. 跨边界祖先语义

普通 `parentElement`、`closest()` 和 `contains()` 都会在 Shadow Root 边界停止，因此现有
层级与过滤逻辑必须改用 composed tree 关系。

`composedParent()` 顺序：

1. 若元素被 slot 分发，父级为 `assignedSlot`。
2. 否则有 `parentElement` 时返回普通父元素。
3. 否则若根为 `ShadowRoot`，返回该根的 `host`。
4. 到达 Document 时返回 `null`。

以下逻辑改用 composed 祖先：

- 已收录元素栈与 `depth` 计算。
- Host 的 `hidden`、`aria-hidden`、`display:none`、`visibility:hidden` 对内部元素生效。
- 内联事件祖先过滤。
- 被过滤交互祖先判断。
- 行、列表项和卡片上下文定位。
- cursor 推断时的语义叶子祖先判断。

不会跨 Shadow 边界错误建立原生 `<label>` 包裹关系；label/控件关联仍遵守各自 Tree
Scope 的 DOM 语义。

## 6. 可访问名与 Tree Scope

`aria-labelledby` 和 `label[for]` 不能固定从 `ownerDocument` 查询。影子树内部的 ID 只在
该 Shadow Root 的 Tree Scope 内有效，Document API 看不到。

调整为：

- 元素根为 `Document` 时在 Document 查询。
- 元素根为 `ShadowRoot` 时在该 Shadow Root 查询。
- slot 分发的 light DOM 元素仍属于原 Document Tree Scope，不错误地改到 Shadow Root。

显式 `aria-label`、placeholder、title、文本和凭据脱敏顺序保持不变。

## 7. 快照与控制器数据流

```text
Document / ShadowRoot / Element root
  → composedElements(root)
  → 可见性、角色、可访问名、上下文过滤
  → snapshot.elements[i] 与 domElements[i] 同步追加
  → PageController 保存 domElements
  → click/input/select/scroll(index) 操作真实元素
```

索引仍从 0 连续递增。影子树元素与普通元素共享同一索引空间，不新增“root id”或复合坐标。

`Element.isConnected` 对连接在 Document 上的 Shadow DOM 元素为 `true`，现有失效校验继续
适用；Host 被移除后内部元素会变为未连接，旧索引自动失效。

控制器中需要扫描整页的辅助路径改用同一个 composed 遍历：

- `validationErrors()` 能看到 open Shadow Root 内的表单校验提示。
- 无显式索引时的最大滚动容器回退能发现影子树内部滚动区。

## 8. 遮挡、视口和交互

- 视口判断继续读取真实元素的盒模型，无需 Shadow DOM 特判。
- 遮挡判断已经优先使用元素所属 `ShadowRoot.elementFromPoint()`，保留现有实现。
- 点击序列中的 pointer/mouse 事件已设置 `composed: true`，可跨边界触发 Host 监听器。
- 原生 `element.click()`、focus、input/change 仍直接作用于真实元素。
- 复合下拉的选项发现继续依赖动作后的全页快照；遍历升级后可同时覆盖影子树浮层。

## 9. 性能

单次抓取只做一次 composed tree 深度优先遍历，复杂度为 `O(n)`，其中 `n` 是真实渲染树
中可访问的 open DOM 元素数。

不先收集每个 Root 再排序，不为 closed Root 安装全局 patch，不引入 MutationObserver。
现有 `MeasureCache` 继续按元素缓存样式和矩形。

## 10. 测试策略

### 10.1 Composed Tree 单元测试

- 普通 DOM 顺序保持不变。
- open Shadow Root 在 Host 所在位置展开。
- 多层嵌套 open Shadow Root。
- slot 分发元素按 slot 位置出现。
- slot 无分发内容时使用 fallback。
- 未分发 light DOM 不出现。
- 同一分发元素只出现一次。
- closed Shadow Root 不可见。
- 单个异常 slot/Host 不阻断后续元素。

### 10.2 快照契约测试

- 普通 DOM、影子树和 slot 内容混排时索引连续、顺序正确。
- 跨 Shadow 边界的交互元素层级正确。
- 隐藏 Host 内部元素不收录。
- Shadow Root 内 `aria-labelledby` 与 `label[for]` 正确命名。
- 影子树正文与纯文本 slot 进入正确位置，slot 文本可作为内部控件名称，凭据字段仍脱敏。
- `detectClickableCursor: false` 仍只收语义候选，但会穿透影子树寻找它们。

### 10.3 控制器测试

- 按索引点击影子树按钮，真实监听器只触发一次。
- 输入和选择继续操作影子树真实元素。
- Host 移除后旧索引报失效。
- 影子树校验错误可被识别。
- 最大滚动容器回退能选择影子树内部容器。

### 10.4 回归门槛

- executor 全部测试。
- 全仓测试。
- 所有 workspace 类型检查。
- 所有 workspace 构建。
- `git diff --check`。

## 11. 改动文件

| 文件 | 计划改动 |
|---|---|
| `packages/executor/src/composedTree.ts` | 新增 composed 遍历、祖先和 Tree Scope 私有工具 |
| `packages/executor/src/composedTree.spec.ts` | 新增遍历顺序、slot、嵌套、去重和降级测试 |
| `packages/executor/src/snapshot.ts` | 接入 composed 遍历和跨边界语义 |
| `packages/executor/src/snapshot.spec.ts` | 增加可见性、名字、层级和正文契约测试 |
| `packages/executor/src/crossFramework.spec.ts` | 将 P2 待实现用例改为正向契约，保留 closed Root 边界 |
| `packages/executor/src/controller.ts` | 整页辅助扫描接入 composed 遍历 |
| `packages/executor/src/controller.spec.ts` | 增加影子树动作、失效、校验和滚动测试 |
| `docs/feat_20260801_ShadowDOM元素捕获/` | 聚合设计、计划、测试结果和复审记录 |

## 12. 非目标

- 不访问 closed Shadow Root。
- 不穿透 iframe；iframe 仍需独立页面上下文或后续专门设计。
- 不实现完整 W3C Accessibility Tree 或浏览器级 slot layout 仿真。
- 不修改公开 API，不新增配置开关；open Shadow DOM 捕获默认启用。
- 不为某个 Web Components 框架读取 class、组件实例或私有字段。
