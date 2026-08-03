import { describe, expect, it } from 'vitest'
import { PAGE_AGENT_SCENARIOS } from './scenarios'
import { resolveRealEvalConfig } from './realEvalConfig'

describe('resolveRealEvalConfig', () => {
  it.each([
    ['IPv4 loopback', 'http://127.0.0.1:8788/llm/chat'],
    ['localhost', 'http://localhost:8788/llm/chat'],
    ['IPv6 loopback', 'http://[::1]:8788/llm/chat'],
    ['尾斜杠', 'http://127.0.0.1:8788/llm/chat/']
  ])('接受%s代理端点', (_label, endpoint) => {
    expect(resolveRealEvalConfig({
      PAGE_AGENT_EVAL_REAL_ENDPOINT: endpoint
    }).endpoint).toBe(endpoint.replace(/\/$/, ''))
  })

  it.each([
    ['远端 host', 'https://api.example.com/llm/chat'],
    ['伪 localhost', 'http://localhost.example.com/llm/chat'],
    ['其他 path', 'http://127.0.0.1:8788/chat'],
    ['额外 path', 'http://127.0.0.1:8788/llm/chat/extra'],
    ['userinfo', 'http://user:secret@127.0.0.1:8788/llm/chat'],
    ['query', 'http://127.0.0.1:8788/llm/chat?token=secret'],
    ['hash', 'http://127.0.0.1:8788/llm/chat#secret']
  ])('拒绝%s端点', (_label, endpoint) => {
    expect(() => resolveRealEvalConfig({
      PAGE_AGENT_EVAL_REAL_ENDPOINT: endpoint
    })).toThrow(/PAGE_AGENT_EVAL_REAL_ENDPOINT/)
  })

  it('显式空白模型名会失败，不回退到 LLM_MODEL', () => {
    expect(() => resolveRealEvalConfig({
      PAGE_AGENT_EVAL_REAL_MODEL: '   ',
      LLM_MODEL: 'fallback-model'
    })).toThrow('PAGE_AGENT_EVAL_REAL_MODEL 不能为空')
  })

  it.each([
    ['attempts 非正整数', { PAGE_AGENT_EVAL_REAL_ATTEMPTS: '0' }],
    ['attempts 超安全整数', {
      PAGE_AGENT_EVAL_REAL_ATTEMPTS: '9007199254740992'
    }],
    ['attempts 超成本上限', { PAGE_AGENT_EVAL_REAL_ATTEMPTS: '21' }],
    ['maxRounds 非正整数', { PAGE_AGENT_EVAL_REAL_MAX_ROUNDS: '-1' }],
    ['maxRounds 超安全整数', {
      PAGE_AGENT_EVAL_REAL_MAX_ROUNDS: '9007199254740992'
    }],
    ['maxRounds 超成本上限', { PAGE_AGENT_EVAL_REAL_MAX_ROUNDS: '101' }]
  ])('拒绝%s', (_label, env) => {
    expect(() => resolveRealEvalConfig(env)).toThrow(/必须|不能超过/)
  })

  it('未知场景 ID 明确失败', () => {
    expect(() => resolveRealEvalConfig({
      PAGE_AGENT_EVAL_REAL_SCENARIOS: 'read-data,unknown-case'
    })).toThrow('PAGE_AGENT_EVAL_REAL_SCENARIOS 包含未知 ID: unknown-case')
  })

  it('缺省使用十场景、3 次和 20 轮预算', () => {
    const config = resolveRealEvalConfig({})

    expect(config.repetitions).toBe(3)
    expect(config.maxRounds).toBe(20)
    expect(config.scenarios.map(scenario => scenario.id)).toEqual(
      PAGE_AGENT_SCENARIOS.map(scenario => scenario.id)
    )
  })
})
