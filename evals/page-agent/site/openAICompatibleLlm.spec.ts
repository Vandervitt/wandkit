import type { LlmMessage } from '../../../packages/core/src/index'
import { describe, expect, it } from 'vitest'
import {
  createOpenAICompatibleLlm,
  type OpenAICompatibleExchange
} from './openAICompatibleLlm'

const endpoint = 'http://127.0.0.1:8788/llm/chat'
const model = 'test-model'
const messages: LlmMessage[] = [{ role: 'user', content: '读取页面' }]
const tools = [{ type: 'function', function: { name: 'page_read' } }]

function fetchStub(
  implementation: (
    input: RequestInfo | URL,
    init?: RequestInit
  ) => Promise<Response>
): typeof fetch {
  return implementation as typeof fetch
}

describe('createOpenAICompatibleLlm', () => {
  it('通过本地代理发送 OpenAI-compatible 请求并返回 assistant message', async () => {
    const requests: Array<{ input: RequestInfo | URL, init?: RequestInit }> = []
    const exchanges: OpenAICompatibleExchange[] = []
    const llm = createOpenAICompatibleLlm({
      endpoint,
      model,
      fetchImpl: fetchStub(async (input, init) => {
        requests.push({ input, init })
        return new Response(JSON.stringify({
          model,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call-1',
              type: 'function',
              function: { name: 'page_read', arguments: '{}' }
            }]
          }
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }),
      onExchange: exchange => exchanges.push(exchange)
    })

    const reply = await llm.chat(messages, tools)

    expect(reply).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call-1',
        type: 'function',
        function: { name: 'page_read', arguments: '{}' }
      }]
    })
    expect(requests).toHaveLength(1)
    expect(String(requests[0]?.input)).toBe(endpoint)
    expect(requests[0]?.init).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    })
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      model,
      messages,
      tools,
      temperature: 0
    })
    expect(exchanges).toEqual([{
      request: { model, messages, tools, temperature: 0 },
      response: {
        status: 200,
        body: {
          model,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call-1',
              type: 'function',
              function: { name: 'page_read', arguments: '{}' }
            }]
          }
        }
      }
    }])
  })

  it('代理网络请求失败时使用稳定基础设施 marker', async () => {
    const llm = createOpenAICompatibleLlm({
      endpoint,
      model,
      fetchImpl: fetchStub(async () => {
        throw new Error('ECONNREFUSED')
      })
    })

    await expect(llm.chat(messages, tools)).rejects.toThrow(
      'PAGE_AGENT_EVAL_REAL_INFRASTRUCTURE_ERROR: ' +
      'OpenAI-compatible 代理请求失败: ECONNREFUSED'
    )
  })

  it('代理 HTTP 错误会携带状态码和上游原因失败', async () => {
    const exchanges: OpenAICompatibleExchange[] = []
    const llm = createOpenAICompatibleLlm({
      endpoint,
      model,
      fetchImpl: fetchStub(async () => new Response(
        JSON.stringify({ error: 'LLM 401: invalid key' }),
        { status: 502, headers: { 'Content-Type': 'application/json' } }
      )),
      onExchange: exchange => exchanges.push(exchange)
    })

    await expect(llm.chat(messages, tools)).rejects.toThrow(
      'PAGE_AGENT_EVAL_REAL_INFRASTRUCTURE_ERROR: ' +
      'OpenAI-compatible 代理 HTTP 502: LLM 401: invalid key'
    )
    expect(exchanges[0]?.response).toEqual({
      status: 502,
      body: { error: 'LLM 401: invalid key' }
    })
  })

  it('代理成功响应缺少 message 时明确报告结构异常', async () => {
    const llm = createOpenAICompatibleLlm({
      endpoint,
      model,
      fetchImpl: fetchStub(async () => new Response(
        JSON.stringify({ model, choices: [] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      ))
    })

    await expect(llm.chat(messages, tools)).rejects.toThrow(
      'PAGE_AGENT_EVAL_REAL_INFRASTRUCTURE_ERROR: ' +
      'OpenAI-compatible 代理返回结构异常: 缺少 assistant message'
    )
  })

  it('把 Runtime 的 AbortSignal 原样传给 fetch 并保留 AbortError', async () => {
    const controller = new AbortController()
    const abortError = new DOMException('This operation was aborted', 'AbortError')
    const llm = createOpenAICompatibleLlm({
      endpoint,
      model,
      fetchImpl: fetchStub(async (_input, init) => {
        expect(init?.signal).toBe(controller.signal)
        throw abortError
      })
    })

    await expect(llm.chat(messages, tools, controller.signal)).rejects.toBe(
      abortError
    )
  })

  it('请求与原始交换回调均不包含 Authorization 或 API Key 字段', async () => {
    let capturedInit: RequestInit | undefined
    let capturedExchange: OpenAICompatibleExchange | undefined
    const llm = createOpenAICompatibleLlm({
      endpoint,
      model,
      fetchImpl: fetchStub(async (_input, init) => {
        capturedInit = init
        return new Response(JSON.stringify({
          model,
          message: { role: 'assistant', content: '完成' }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }),
      onExchange: exchange => {
        capturedExchange = exchange
      }
    })

    await llm.chat(messages, tools)

    expect(JSON.stringify(capturedInit?.headers)).not.toMatch(/authorization|api.?key/i)
    expect(JSON.stringify(capturedExchange)).not.toMatch(/authorization|api.?key/i)
  })

  it('超过单次 attempt 模型轮次预算时在发起下一次请求前失败', async () => {
    let fetchCalls = 0
    const exchanges: OpenAICompatibleExchange[] = []
    const llm = createOpenAICompatibleLlm({
      endpoint,
      model,
      maxRounds: 2,
      fetchImpl: fetchStub(async () => {
        fetchCalls += 1
        return new Response(JSON.stringify({
          model,
          message: { role: 'assistant', content: '继续' }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }),
      onExchange: exchange => exchanges.push(exchange)
    })

    await llm.chat(messages, tools)
    await llm.chat(messages, tools)
    await expect(llm.chat(messages, tools)).rejects.toThrow(
      'PAGE_AGENT_EVAL_REAL_MAX_ROUNDS_EXCEEDED: 单次尝试超过 2 个模型轮次'
    )
    expect(fetchCalls).toBe(2)
    expect(exchanges).toHaveLength(2)
  })

  it('代理响应缺少实际 model 时明确失败', async () => {
    const llm = createOpenAICompatibleLlm({
      endpoint,
      model,
      fetchImpl: fetchStub(async () => new Response(JSON.stringify({
        message: { role: 'assistant', content: '完成' }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    })

    await expect(llm.chat(messages, tools)).rejects.toThrow(
      'PAGE_AGENT_EVAL_REAL_INFRASTRUCTURE_ERROR: ' +
      'OpenAI-compatible 代理返回结构异常: 缺少实际 model'
    )
  })

  it('读取代理响应 body 失败时使用稳定基础设施 marker', async () => {
    const llm = createOpenAICompatibleLlm({
      endpoint,
      model,
      fetchImpl: fetchStub(async () => ({
        ok: true,
        status: 200,
        text: async () => {
          throw new Error('body stream failed')
        }
      }) as unknown as Response)
    })

    await expect(llm.chat(messages, tools)).rejects.toThrow(
      'PAGE_AGENT_EVAL_REAL_INFRASTRUCTURE_ERROR: ' +
      'OpenAI-compatible 代理响应读取失败: body stream failed'
    )
  })

  it('代理实际 model 与请求 model 不一致时明确失败', async () => {
    const llm = createOpenAICompatibleLlm({
      endpoint,
      model,
      fetchImpl: fetchStub(async () => new Response(JSON.stringify({
        model: 'other-model',
        message: { role: 'assistant', content: '完成' }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    })

    await expect(llm.chat(messages, tools)).rejects.toThrow(
      'PAGE_AGENT_EVAL_REAL_INFRASTRUCTURE_ERROR: ' +
      'OpenAI-compatible 代理模型不一致: 请求 test-model，响应 other-model'
    )
  })
})
