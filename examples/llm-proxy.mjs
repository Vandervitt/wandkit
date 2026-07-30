/**
 * 本地 LLM 代理——供浏览器端联调使用。
 *
 * 它扮演的是**真实项目里的后端**：Key 只存在于这个进程里，浏览器拿到的只有一个
 * 同源（或跨源带 CORS）的 `/llm/chat` 端点。本包的核心主张之一就是「Key 永远不进
 * 前端」，浏览器侧联调若直接把 Key 塞进页面，就等于示范了自己反对的做法。
 *
 * 运行：
 *   node examples/llm-proxy.mjs          # 默认 http://127.0.0.1:8788
 *   PORT=9000 node examples/llm-proxy.mjs
 *
 * 前端这样接：
 *   llm: {
 *     chat: async (messages, tools, signal) => {
 *       const r = await fetch('http://127.0.0.1:8788/llm/chat', {
 *         method: 'POST',
 *         headers: { 'Content-Type': 'application/json' },
 *         body: JSON.stringify({ messages, tools }),
 *         signal
 *       })
 *       return (await r.json()).message
 *     }
 *   }
 *
 * **仅供本地开发**：它对任何来源都放行，不做鉴权，不要部署到任何公网环境。
 */
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'

/** 极简 .env 解析：样例不值得为此引一个依赖。 */
function loadEnv() {
  const env = { ...process.env }
  try {
    readFileSync(new URL('../.env', import.meta.url), 'utf8')
      .split('\n')
      .forEach(line => {
        const matched = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/)
        if (matched && !env[matched[1]]) env[matched[1]] = matched[2].trim()
      })
  } catch (_error) {
    // 没有 .env 就只用真实环境变量
  }
  return env
}

const env = loadEnv()
const BASE_URL = env.LLM_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4'
const MODEL = env.LLM_MODEL || 'glm-4-flash'
const API_KEY = env.LLM_API_KEY
const PORT = Number(env.PORT || 8788)

if (!API_KEY) {
  console.error('\n缺少 LLM_API_KEY。请 cp .env.example .env 后填入。\n')
  process.exit(1)
}

/** 联调时最有价值的信息是「模型到底看到了什么、又决定了什么」。 */
function describe(messages, reply) {
  const last = [...messages].reverse().find(m => m.role === 'user' || m.role === 'tool')
  const asked = last ? `${last.role}: ${String(last.content ?? '').slice(0, 60)}` : '—'
  const decided = reply.tool_calls?.length
    ? reply.tool_calls.map(c => `${c.function.name}(${c.function.arguments})`).join(' ')
    : String(reply.content ?? '').slice(0, 80)
  return `  ← ${asked}\n  → ${decided}`
}

const server = createServer((req, res) => {
  // 浏览器从 dev server 的源过来，必然跨源
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')

  if (req.method === 'OPTIONS') return res.writeHead(204).end()
  if (req.method !== 'POST' || !req.url?.startsWith('/llm/chat')) {
    return res.writeHead(404).end('not found')
  }

  const chunks = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', async () => {
    try {
      const { messages, tools } = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const upstream = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${API_KEY}`
        },
        body: JSON.stringify({ model: MODEL, messages, tools, temperature: 0 })
      })

      if (!upstream.ok) {
        const detail = (await upstream.text()).slice(0, 300)
        console.error(`  ✗ 上游 ${upstream.status}: ${detail}`)
        res.writeHead(502, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ error: `LLM ${upstream.status}: ${detail}` }))
      }

      const payload = await upstream.json()
      const raw = payload.choices?.[0]?.message
      if (!raw) throw new Error('LLM 返回结构异常')
      // 只回传运行时需要的三个字段，不把上游的其余结构泄给前端
      const message = {
        role: 'assistant',
        content: raw.content ?? null,
        tool_calls: raw.tool_calls
      }
      console.log(describe(messages, message))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ message }))
    } catch (error) {
      console.error(`  ✗ ${error.message}`)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: error.message }))
    }
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`LLM 代理已启动：http://127.0.0.1:${PORT}/llm/chat`)
  console.log(`模型：${MODEL} @ ${BASE_URL}`)
  console.log('Key 只在本进程内，浏览器拿不到。仅供本地开发。\n')
})
