# 样例

| 样例 | 命令 | 需要 Key | 演示什么 |
|---|---|---|---|
| `01-fake-llm.ts` | `npm run example` | 否 | 完整闸门链路，确定性回放，可进 CI |
| `02-real-llm.ts` | `npm run example:llm` | 是 | 模型**真的自己挑工具**，破坏性操作照样被拦 |

## 申请一个免费 Key

四家都提供 OpenAI 兼容接口，换个 `base_url` 和模型名就能互换。

| 平台 | 免费额度 | 申请地址 |
|---|---|---|
| **智谱 GLM**（推荐） | GLM-4-Flash **永久免费不限量**（只限并发），注册再送 2000 万 token | <https://www.bigmodel.cn/> |
| 硅基流动 | 注册送代金券，小参数量 Qwen / GLM 永久免费 | <https://cloud.siliconflow.cn/> |
| 阿里百炼 | 每个模型 100 万 token，90 天有效 | <https://bailian.console.aliyun.com/> |
| DeepSeek | 新用户 500 万 token，30 天有效 | <https://platform.deepseek.com/> |

推荐智谱 GLM-4-Flash：永久免费，样例反复跑不心疼，工具调用也稳。

> 各家的免费政策变动频繁，上表是 2026 年 7 月的情况，以官网为准。

## 配置

```bash
cp .env.example .env
# 编辑 .env，填入 LLM_API_KEY
npm run example:llm
```

`.env` 已在 `.gitignore` 里。

**Key 不写进代码**——这既是为了不让它进版本库，也因为本包的核心主张就是「Key 永远不进前端」。样例不该示范它自己反对的做法。

样例是 Node 脚本，没有浏览器暴露面，所以直接调厂商接口。**真实的前端项目必须指向自己的后端**，由后端持有 Key：

```ts
llm: {
  chat: (messages, tools, signal) =>
    request('/api/llm/chat', { messages, tools }, signal)
}
```

## `01-fake-llm.ts`

用 `FakeLlm` 回放固定响应，四个场景各跑一遍：

```
【场景一】查询 —— read 工具，无需确认
  终态: completed

【场景二】删除 —— destructive 工具
  Run 状态: awaiting_confirmation      ← 挂起了，数据没动
  >> 用户点击【确认执行】
  终态: completed｜数据库仍有 u_1: false

【场景三】确认卡片停留期间，数据被别人改了
  [工具结果] ok=false The target or impact of this operation has changed…
  终态: failed｜数据库仍有 u_2: true    ← 拒绝执行

【场景四】用户点【取消】
  [工具结果] ok=false Cancelled by user.
```

场景三是重点：确认卡片停在屏幕上的那几十秒里数据被改了，即使用户点了批准也不放行。

不需要网络和 Key，结果确定，适合放进 CI 当冒烟测试。

## `02-real-llm.ts`

同样的业务域，但 LLM 是真的在推理。观察三件事：

1. **模型自己选工具。** 「有哪些待审核的用户？」→ 它决定调 `user_query_v1` 并填 `status: '待审核'`，没有任何脚本写死。
2. **它得自己把姓名解析成 id。** 用户说「把张三删掉」，而工具要的是 `u_1`。模型要么先查一次，要么从注入的页面上下文里读出来——两条路都行，看它怎么选。
3. **无论它决定什么，闸门照拦。** 破坏性工具走的是 `prepare`，屏幕上先出现确认卡片，`execute` 只有在人点了确认之后才会被调到。

输出里 `prepare（只造卡片，不写库）` 和 `execute（真正写库）` 两行分开打印，能直接看到这条边界。

末尾会打印一次审计轨迹：候选模块 → 模型请求 → 参数校验 → prepare → 确认决定 → 工具结果。

## 换个模型试试

值得试的一件事：把 `.env` 里的模型换成参数量更小的（比如 `Qwen/Qwen3-8B`），观察它在「张三 → u_1」这一步上会不会开始瞎编 id。

这正是设计上要防的：**模型可以出错，但出错不该等于数据没了**。id 编错了，`prepare` 会因为查不到用户而失败；就算它蒙对了 id，确认卡片也会把真实的用户名摆在人眼前。
