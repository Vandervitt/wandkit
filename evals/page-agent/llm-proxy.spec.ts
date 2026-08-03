import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const children: ChildProcessWithoutNullStreams[] = []
const servers: Server[] = []

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill('SIGTERM')
    if (child.exitCode === null) await once(child, 'exit')
  }
  for (const server of servers.splice(0)) {
    if (server.listening) await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
    })
  }
})

describe('examples/llm-proxy.mjs', () => {
  it('使用请求 model 调上游并在响应中返回实际 model', async () => {
    const upstreamBodies: Array<Record<string, unknown>> = []
    const upstream = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', chunk => chunks.push(Buffer.from(chunk)))
      request.on('end', () => {
        upstreamBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({
          model: 'upstream-actual-model',
          choices: [{ message: { role: 'assistant', content: '完成' } }]
        }))
      })
    })
    servers.push(upstream)
    const upstreamPort = await listen(upstream)
    const proxyPort = await reservePort()
    const proxy = spawn(process.execPath, ['examples/llm-proxy.mjs'], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PORT: String(proxyPort),
        LLM_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
        LLM_MODEL: 'proxy-default-model',
        LLM_API_KEY: 'test-only-key'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    children.push(proxy)
    await waitForReady(proxy)

    const response = await fetch(`http://127.0.0.1:${proxyPort}/llm/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'requested-model',
        messages: [{ role: 'user', content: '测试' }],
        tools: []
      })
    })

    expect(response.status).toBe(200)
    expect(upstreamBodies[0]).toMatchObject({ model: 'requested-model' })
    await expect(response.json()).resolves.toMatchObject({
      model: 'upstream-actual-model',
      message: { role: 'assistant', content: '完成' }
    })
  })

  it.each([
    ['缺少', undefined],
    ['空白', '   ']
  ])('上游成功响应%s实际 model 时返回 502 结构错误', async (
    _label,
    upstreamModel
  ) => {
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({
        ...(upstreamModel === undefined ? {} : { model: upstreamModel }),
        choices: [{ message: { role: 'assistant', content: '完成' } }]
      }))
    })
    servers.push(upstream)
    const upstreamPort = await listen(upstream)
    const proxyPort = await reservePort()
    const proxy = spawn(process.execPath, ['examples/llm-proxy.mjs'], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PORT: String(proxyPort),
        LLM_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
        LLM_MODEL: 'proxy-default-model',
        LLM_API_KEY: 'test-only-key'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    children.push(proxy)
    await waitForReady(proxy)

    const response = await fetch(`http://127.0.0.1:${proxyPort}/llm/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'requested-model',
        messages: [{ role: 'user', content: '测试' }],
        tools: []
      })
    })

    expect(response.status).toBe(502)
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('LLM 返回结构异常: 缺少实际 model')
    })
  })
})

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('无法获取测试端口')
  return address.port
}

async function reservePort(): Promise<number> {
  const server = createServer()
  const port = await listen(server)
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
  })
  return port
}

async function waitForReady(child: ChildProcessWithoutNullStreams): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => {
      reject(new Error(`本地代理启动超时: ${output}`))
    }, 5_000)
    const onData = (chunk: Buffer): void => {
      output += chunk.toString('utf8')
      if (!output.includes('LLM 代理已启动')) return
      clearTimeout(timer)
      resolve()
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.once('exit', code => {
      clearTimeout(timer)
      reject(new Error(`本地代理提前退出 ${code}: ${output}`))
    })
  })
}
