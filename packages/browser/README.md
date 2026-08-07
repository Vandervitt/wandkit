# @wandkit/browser

面向浏览器宿主的一调用集成层。它把 `AgentRuntime`、通用 DOM executor、聊天 Web
Components、交互遮罩、请求拦截器和请求跟踪器组装成一个可销毁实例。

## 安装与使用

```bash
npm install @wandkit/browser
```

```ts
import { mountWandkit } from '@wandkit/browser'

const app = mountWandkit({
  llm: {
    chat(messages, tools, signal) {
      return backend.chat({ messages, tools, signal })
    }
  },
  heading: 'Admin Copilot',
  getPermissions: () => store.getters.permissions,
  interception: {
    llmRequest: { method: 'POST', url: '/api/llm/chat' },
    policy: {
      allow: [
        {
          id: 'search-customers',
          match: { method: 'POST', url: '/api/customers/search' }
        }
      ],
      danger: [
        {
          id: 'delete-customer',
          match: { method: 'DELETE', url: '/api/customers/:id' }
        }
      ]
    }
  }
})

app.destroy()
```

`llm.chat()` 必须调用宿主自己的后端代理，并透传 `signal`；模型 API Key 不得进入浏览器。

## 默认安全行为

- GET、HEAD、OPTIONS、TRACE 默认放行。
- Agent 发起的其他请求默认展示确认卡；未配置的写请求不会静默放行。
- `danger` 先于 `allow` 匹配，避免宽泛放行规则吞掉高危请求。
- `llmRequest` 只放行精确匹配的模型代理请求，避免页面动作 attribution grace window
  内重复确认；不会为整个异步 `llm.chat()` 打开全局授权窗口。
- `page_read` 不遮罩；click、input、select、scroll 在动作与网络/DOM 稳定等待期间遮罩。
- 拒绝请求会让页面工具返回 `{ cancelled: true }`，模型不能把机械点击误报为业务成功。
- Wandkit 自身 dock、panel、确认卡和 mask 不进入页面快照，Agent 不能操作自己的界面。

安全查询若使用 POST，只为经过核实的精确 endpoint 配置 `allow`；不要用覆盖整个 API
前缀的通配规则。以 `/` 开头的 matcher 只比较 pathname；单个 `*` 不跨 `/`，只有 `**`
才跨多段路径。`danger` 仍先于 `llmRequest` 生成的 allow 规则，显式高危规则不会被吞掉。

## 返回值与生命周期

```ts
const { runtime, session, controls, destroy } = app
```

- `runtime`：底层 `AgentRuntime`，用于 trace、状态与高级控制。
- `session`：`ChatSession`，可订阅或导出 OpenAI 形态消息。
- `controls`：发送、停止和确认控制。
- `destroy()`：幂等停止当前 Run、从严结束悬挂确认、解除遮罩、释放自身请求跟踪租约、
  卸载 interceptor、还原 history/Fetch/XHR 并移除 UI。

首版只支持同一 Window 内一个活动实例；多个实例会争用同一组浏览器全局 API patch。
如果宿主已经在 interceptor 之前启动 request tracker，`mountWandkit()` 会拒绝挂载并回滚
本次资源：该顺序会让确认等待发生在 tracker 计数之前，继续运行可能提前解除遮罩。

## 本地 `npm link`

先在 Wandkit 工作区注册六个包：

```bash
(cd packages/core && npm link)
(cd packages/executor && npm link)
(cd packages/interceptor && npm link)
(cd packages/chat && npm link)
(cd packages/ui && npm link)
(cd packages/browser && npm link)
```

再在宿主项目连接，`--no-save` 避免改写依赖清单：

```bash
npm link --no-save \
  wandkit \
  @wandkit/executor \
  @wandkit/interceptor \
  @wandkit/chat \
  @wandkit/ui \
  @wandkit/browser
```

完成本地验证后按宿主包管理器的方式恢复正式依赖，避免把全局 link 留在共享开发环境。
