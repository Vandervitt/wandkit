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
| 1 | 视口过滤 + 缓存 + `offsetWidth` 可见性 | 真实列表页快照 < 60 项且耗时 < 100ms | ✅ 完成（30 项 / 11ms） |
| 2 | 遮挡判定 `isTopElement` | 弹窗打开时底层元素不出现在快照中 | ✅ 完成（三点采样） |
| 3 | 路由变化钩子 + DOM 稳定等待 | 路由切换后索引自动作废并重抓 | ✅ 完成 |
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

## 8. P0 实施后的实测结果（aicc-admin-front 主页）

| 指标 | 实施前 | 实施后 |
|---|---|---|
| 最长可访问名 | 236 字符（整棵菜单子树拼接） | **13 字符** |
| 元素数 | 28 | 30 |
| 耗时 | 3.1ms | 11.1ms |
| 空名元素 | — | **10 个（33%）** |

实施中额外发现并修复两处，均为真实页面才暴露的问题：

**容器吞掉子树文本。** `<ul class="el-menu">` 有 104 个可交互后代，取 `textContent`
得到 236 字符的拼接串，既无法辨识又白烧 token。改为：含可交互后代的元素只取自身
直接文本；无名纯容器整个不收录（真正可点的是里面各自带文本的菜单标题）。

**语义叶子被误判为容器。** `<button><span>删除</span></button>` 的 span 有
`cursor: pointer`，导致 button 被当成容器跳过。语义叶子（button/a/input/select/
textarea）的内部结构只是装饰，必须豁免。

### 遗留：空名元素占 33%

图标按钮（折叠箭头、下拉触发器）没有任何可访问名，模型无从辨识。这正是 P1-4
（属性白名单）要解决的——`title` / `aria-label` / `type` 等属性能补上身份信息。
在那之前它们是纯噪声。

## 9. P1-4 实测结果（同一页面，逐步演进）

| 指标 | P0 前 | P0 后 | P1-4 后 |
|---|---|---|---|
| 元素数 | 28 | 30 | **20** |
| 空名元素 | — | 10（33%） | **0** |
| 最长可访问名 | 236 字符 | 13 | 13 |
| 耗时 | 3.1ms | 11.1ms | 10.1ms |

P1-4 又是两处只有真实页面才暴露的问题：

**`<li>` 不是「行」。** Element UI 侧边栏的 `<li>` 包着整个子菜单，取其文本作行上下文
会得到一整段菜单名拼接。改为要求**叶子行**——含嵌套行容器的是区块不是记录。

**属性白名单救不了那 10 个空名元素。** 实测它们连 `title` / `aria-label` 都没有，
是纯装饰性图标（折叠箭头等）。模型既无法指称，也不该去点一个自己都说不清的东西，
而它们仍在吃 token。故丢弃「无名且无任何可辨识属性」的**非语义**元素；语义控件
（input/textarea/button）豁免——没有 label 的输入框仍可填写，模型能靠位置推断。

### 层级 vs 行上下文

原计划用层级缩进解决表格里多个同名「删除」的消歧，实施后发现**行不通**：`<tr>` 通常
既无 `role` 也无 `tabindex`，本身不可交互，根本不会进入快照，因此按钮之间没有可区分
的父节点。

真正管用的是 `context`——把所在行的文本带上：

```
[0] button 删除 (国光科技)
[1] button 删除 (示例公司)
```

层级缩进仍然保留，它对真正嵌套的可交互元素（多级菜单）有效。

## 10. 真实列表页验证（客户管理，77 个可交互元素）

主页元素少、无表格，P1-4 的核心能力其实没被触发。换到客户管理列表页后，行上下文
**当场失效**：45 个操作按钮全部没有上下文，「详情/编辑/登录/更多」在 8 行里重复
出现，模型完全无法区分是哪个客户。

两个原因：

1. **整行文本 187 字符**，远超 60 上限。真实后台一行有 10 个单元格，状态、计费、
   时间全在里面。
2. **行内含嵌套 `<li>`**（操作列的「更多」下拉浮层），被叶子行规则拒绝。

而答案就在数据里：**首格文本是 `wzp ID: 76`**——正是这条记录的标识，10 个字符。
首列即标识是后台表格的通例。

因此表格行改走独立路径：取首格而非整行，且不要求叶子行（下拉浮层不影响首格）。
列表项没有单元格概念，仍走「叶子 + 长度上限」的整体文本路径。

| 指标 | 改前 | 改后 |
|---|---|---|
| 有行上下文的元素 | 0 | **45** |
| 耗时 | 23.1ms | 10.0ms |

```
详情 → wzp ID: 76
编辑 → wzp ID: 76
详情 → E2E多线路参考价_20260724 ID: 75
详情 → 测试变量 ID: 74
```

**教训**：主页那种简单页面验证不了消歧类能力。列表页才是这类后台的真实形态，应当
作为默认的验证目标。

## 11. 跨框架验证

此前全部验证来自 Vue 2 + Element UI 单一技术栈，存在「针对单一框架调优」的风险。
补充三种结构截然不同的形态，在真实浏览器中实测：

| 形态 | 关键差异 | 结果 |
|---|---|---|
| **纯 HTML** | 零框架，`label[for]` 跨兄弟关联 | ✅ 全部识别 |
| **Ant Design（React）** | `<a>` 当按钮、`role` 挂在 readonly input 上 | ✅ 行上下文与 combobox 均正常 |
| **Shadow DOM** | DOM 边界隔离 | ⚠️ 需显式穿透（P2） |

Ant Design 的表格实测输出，与 Element UI 完全一致的质量：

```
编辑→AntD行一   删除→AntD行一
编辑→AntD行二   删除→AntD行二
```

### 源码审计

`grep` 全部源文件确认：**代码中零框架 API**（无 `__vue__` / `_vnode` / `$refs` /
`__reactFiber` / `__ngContext`）。Vue、React、Element UI 仅出现在注释里用于解释设计
理由。实际依赖的全部是 Web 标准：

`getAttribute`（aria-* / placeholder / contenteditable）、`querySelector`、`closest`、
`matches`、`getComputedStyle`、`getBoundingClientRect`、`getClientRects`、
`elementFromPoint`、`MutationObserver`、`history.pushState` / `popstate` / `hashchange`

唯一「像框架」的地方是 `role="combobox"` 一类 ARIA 属性，但那是 W3C 标准而非框架约定。

### 一处澄清

真实浏览器测试中曾出现「纯 HTML 的 `label[for]` 失效」，排查后确认是**一次性验证探针
漏写了该分支**，源码 `labelText()` 中一直存在且有测试覆盖（`snapshot.spec.ts:75`）。
教训：临时探针不能当作实现的等价物，跨框架结论必须回落到正式测试。

## 12. 端到端验证：本包真实代码 × 真实应用

前面各轮验证用的都是在控制台里手写的等价探针。这一轮改为把 `packages/executor/src`
用 esbuild 打成 IIFE 注入页面，跑的是**本包的实际代码**。

### 通过的闭环

在客户管理列表页完成「读页面 → 填筛选 → 点搜索 → 重读确认」：

| 环节 | 结果 |
|---|---|
| `capturePage` | 70 元素 / 21.8ms / 51 个行上下文 / 4 个空名 |
| `input()` 写入「wzp」 | ✅ 值写入成功 |
| **Vue 双向绑定同步** | ✅ `v-model` 收到值 |
| `click()` 触发查询 | ✅ 真实 API 调用，页面显示「共 2 条」 |
| 行标识 | `wzp ID: 76` / `test-wzp ID: 72` |

Vue 双向绑定同步这条尤其值得记录：它证明 `input()` 里补派发 `input` / `change`
事件那段代码是必要且正确的——直接赋值 `value` 框架感知不到。

### 发现并修复：静默 ≠ 稳定

`captureStable()` 在真实查询后返回了**空表格**：

| | 修复前 | 修复后 |
|---|---|---|
| `captureStable` 后行数 | **0** | 2 |
| 再等 1500ms 后行数 | 8 | 2 |
| 耗时 | 329ms | 1021ms |

根因：点击后表格先清空（一次 DOM 变更），随后**等待 API 响应的几百毫秒里 DOM 完全
静止**——300ms 静默期在这个空窗里被满足，于是在数据回来之前就抓取了。

修复：把在途请求纳入稳定判据。DOM 不动**且**没有请求在等，才算真的稳定。计数器
patch `fetch` 与 `XMLHttpRequest.prototype.send`，只计数不改写内容，因此与
`@toolairlock/interceptor` 的治理职责正交，两者可同时安装。

`XHR` 侧监听 `loadend` 而非 `load`：前者覆盖成功、失败、中止三种终态。

### 方法论修正

此前几轮都用手写探针验证，其中一次还因探针漏写 `label[for]` 分支而险些误判为实现
缺陷。**探针不能替代真实代码**——本轮把真实构建产物注入页面，才暴露出
`captureStable` 这个手写探针根本不涉及的时序缺陷。
