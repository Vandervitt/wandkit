# DOM 抓取方案（对标 page-agent 实现）

> 配套：[design.md](./design.md) §4.3 / §4.4
> 依据：alibaba/page-agent `packages/page-controller/src/dom/dom_tree/index.js` 与 `dom/index.ts` 实测源码

## 1. 我们当前实现与 page-agent 的差距

| 能力 | page-agent | 我们（`db1714b`） | 影响 |
|---|---|---|---|
| 可交互判定：语义标签 | ✅ | ✅ | — |
| 可交互判定：ARIA role | ✅ | ✅ | — |
| 可交互判定：cursor | ✅ `pointer/move/text/grab` 等**多种** | ⚠️ 仅 `pointer` | 漏掉可拖拽、可编辑区域 |
| 可交互判定：事件监听器 | ✅ `getEventListeners` + `onclick` 属性兜底 | ❌ | 漏掉纯 JS 绑定且无 cursor 样式的元素 |
| 可交互判定：可滚动容器 | ✅ `isScrollableElement` | ❌ | 无法翻滚内部滚动区 |
| **遮挡判定 `isTopElement`** | ✅ `elementFromPoint` 三点采样 | ❌ | **弹窗打开时仍报出被遮挡的底层元素** |
| **视口过滤 `viewportExpansion`** | ✅ `-1`/`0`/`N px` 三档 | ❌ | **长列表页快照体积失控** |
| Shadow DOM 穿透 | ✅ | ❌ | 组件库用 Shadow DOM 时全瞎 |
| iframe 穿透（含坐标偏移） | ✅ | ❌ | 嵌入页无法操作 |
| 样式/布局缓存 | ✅ WeakMap 三级缓存 | ❌ | 大页面每次全量计算样式 |
| 输出格式 | 层级缩进 + 属性白名单 + `*` 标记新元素 | 扁平单行 | 模型丢失结构信息与变化线索 |
| 黑名单 | ✅ `data-page-agent-not-interactive` | ❌ | 无法排除装饰性元素 |
| **路由变化驱动抓取** | 未见 | ❌ | 见 §3 |

结论：核心思路（逐步重读 + 索引化 + 无框架依赖）一致且已验证，但**工程完备度差距明显**。其中三项是阻断级的：遮挡判定、视口过滤、路由驱动。

## 2. 三项阻断级缺口

### 2.1 遮挡判定（`isTopElement`）

弹窗、抽屉、遮罩打开时，底层元素在 DOM 里依然「可见」（`display` 正常、`offsetWidth > 0`），但**用户点不到**。当前实现会把它们照报，模型据此点击，点在遮罩上，什么也不会发生——而模型以为点成功了。

page-agent 的做法：

```js
// 三点采样：中心 + 左上 + 右下
const topEl = document.elementFromPoint(centerX, centerY)
// Shadow DOM 内用 shadowRoot.elementFromPoint
```

判定该元素或其后代是否为该坐标的最顶层元素。三点而非一点，是为了绕过圆角、部分遮挡的情况。

**这条对本项目尤其关键**：确认卡片本身就是个遮罩层，闸门弹出期间必须保证模型看不到底层元素。

### 2.2 视口过滤（`viewportExpansion`）

后台列表页动辄上百个可交互元素，全量抓取会撑爆 token 预算，且大部分元素在屏幕外、当前根本不该操作。

page-agent 的三档语义：

| 值 | 含义 |
|---|---|
| `-1` | 全页面，不做视口限制 |
| `0` | 仅当前视口内 |
| `N`（正数） | 视口向外扩展 N 像素 |

配合 `scroll` 原语，模型可以「看不到就滚动再看」——这与逐步重读天然契合。

**建议默认取正数**（如 `100`），而非 `0`：纯视口会把刚滚出边缘一点的元素切掉，导致模型反复来回滚动。

### 2.3 路由变化驱动抓取

SPA 路由切换后 DOM 整体替换，此时**上一次快照的所有索引全部失效**。当前实现只在 `capture()` 被显式调用时才重读，若模型基于旧索引继续操作，`elementAt` 会因元素脱离文档而报错——能兜住，但报错来得晚且信息模糊。

正确做法是让路由变化成为**主动信号**：

```ts
// 原生信号，与路由库无关
window.addEventListener('popstate', onRouteChange)   // 前进/后退
window.addEventListener('hashchange', onRouteChange) // hash 路由
// pushState/replaceState 不派发事件，需包装
const origPush = history.pushState
history.pushState = function (...args) {
  const result = origPush.apply(this, args)
  onRouteChange()
  return result
}
```

覆盖三条路径即可涵盖 Vue Router / React Router / 手写 history 封装——**不依赖任何路由库**，与本项目 `RouterPort` 的窄端口风格一致。

路由变化时：作废当前索引映射 → 等待 DOM 稳定 → 重新抓取。

## 3. DOM 稳定等待

路由切换与异步渲染之间存在间隙，立刻抓取会拿到半成品。需要一个「稳定」判据：

```
MutationObserver 监听 subtree
  ↓
连续 N ms（建议 300ms）无变更 → 判定稳定
  ↓
或达到上限（建议 2000ms）→ 超时也返回，绝不无限等
```

超时必须返回而不是抛错：拿到一个不完整的页面，仍好过让整个 Run 卡死。

## 4. 输出格式改造

当前扁平单行丢失了结构信息。page-agent 的格式：

```
[0]<a aria-label=page-agent.js>首页 />
	[1]<div>P />
	[2]<div>page-agent.js UI Agent />
[3]<a>文档 />
```

三处值得采纳：

1. **Tab 缩进表达父子关系** —— 模型据此理解「这个删除按钮属于哪一行」，这在表格里是刚需。当前扁平格式下，五行数据的五个「删除」按钮完全无法区分。
2. **`*` 前缀标记新元素** —— 上次快照没有、这次出现的元素加 `*`。它直接回答「我刚才那次点击造成了什么」，对下拉展开、弹窗出现这类场景极其有效。
3. **属性白名单** —— `title/type/checked/name/role/value/placeholder/alt/aria-label/aria-expanded/aria-checked/id/for/target/aria-haspopup/aria-controls/contenteditable`，值截断至 20 字符。

**但保留我们的凭据脱敏**：page-agent 的白名单里含 `value`，直接照搬会把密码明文送进模型——这是我们已实测到并修掉的缺陷（`ad69e65`），不可回退。

## 5. 性能

page-agent 用三个 WeakMap 缓存单次遍历内的 `boundingRects` / `clientRects` / `computedStyles`，每次抓取开始时 `clearCache()`。

我们当前的 `isVisible` 沿祖先链逐级 `getComputedStyle`，在深层 DOM 上是 O(深度) 且无缓存，大页面会明显卡顿。

改用 page-agent 的判据更划算：

```js
element.offsetWidth > 0 && element.offsetHeight > 0 &&
  style.visibility !== 'hidden' && style.display !== 'none'
```

`offsetWidth/Height` 为 0 已经隐含了「祖先被隐藏」的情况，无需自己走祖先链。

## 6. 实施顺序

| 步 | 内容 | 判据 | 优先级 |
|---|---|---|---|
| 1 | 视口过滤 + 缓存 + `offsetWidth` 可见性 | 真实列表页快照 < 60 项且耗时 < 100ms | **P0** |
| 2 | 遮挡判定 `isTopElement` | 弹窗打开时底层元素不出现在快照中 | **P0** |
| 3 | 路由变化钩子 + DOM 稳定等待 | 路由切换后索引自动作废并重抓 | **P0** |
| 4 | 层级缩进 + `*` 新元素标记 + 属性白名单（含脱敏） | 表格中五个「删除」可区分 | P1 |
| 5 | 扩充 cursor 集合 + 事件监听器兜底 + 可滚动容器 | 拖拽、纯 JS 绑定元素可被发现 | P1 |
| 6 | Shadow DOM / iframe 穿透 | 嵌入页可操作 | P2 |
| 7 | 黑名单属性 | 装饰性元素可排除 | P2 |

P0 三项是「能不能在真实后台用」的门槛，P1 是「用得准不准」，P2 是覆盖面扩展。

## 7. 不采纳的部分

| page-agent 的做法 | 我们的选择 | 理由 |
|---|---|---|
| 高亮浮层（`highlightElement`） | 不做 | 我们有 `InteractionMask` 承担归属判定，再加高亮会与之打架 |
| 完整 Agent 循环 | 不做 | 会与 `AgentRuntime` 已有循环叠成两层，轮次上限、trace、预算全部失效 |
| `value` 无条件进输出 | **改为脱敏后进** | 见 §4 |
