import { describe, expect, it, vi } from 'vitest'
import {
  compileUrlPattern,
  evaluateRequest,
  findMatchingRule,
  matchesRequest,
  SAFE_METHODS
} from './policy'
import type { InterceptedRequest, InterceptionPolicy, RequestRule } from './types'

function request(overrides: Partial<InterceptedRequest> = {}): InterceptedRequest {
  return {
    id: 'req-1',
    method: 'POST',
    url: 'https://app.example.com/api/users/u_1',
    headers: {},
    channel: 'fetch',
    timestamp: 0,
    ...overrides
  }
}

function evaluate(
  policy: InterceptionPolicy,
  overrides: Partial<InterceptedRequest> = {},
  flags: { isAgentActive?: boolean, isPreAuthorized?: boolean } = {}
) {
  return evaluateRequest({
    request: request(overrides),
    policy,
    isAgentActive: flags.isAgentActive ?? true,
    isPreAuthorized: flags.isPreAuthorized ?? false
  })
}

const dangerDelete: RequestRule = {
  id: 'danger-delete-user',
  match: { method: 'DELETE', url: '/api/users/:id' }
}

const allowAnyApi: RequestRule = {
  id: 'allow-any-api',
  match: { url: '/api/**' }
}

describe('evaluateRequest —— 判定顺序', () => {
  it('1. 非 Agent 发起的写请求直接放行，不打扰用户自己的操作', () => {
    const result = evaluate(
      { danger: [dangerDelete] },
      { method: 'DELETE' },
      { isAgentActive: false }
    )

    expect(result.verdict.action).toBe('allow')
    expect(result.reason).toBe('not_agent_initiated')
  })

  it('2. 已授权窗口内的写请求放行，避免路径 A 双重确认', () => {
    const result = evaluate({}, { method: 'POST' }, { isPreAuthorized: true })

    expect(result.verdict.action).toBe('allow')
    expect(result.reason).toBe('pre_authorized')
  })

  it('2. 已授权窗口优先于危险名单——人已经批准过这次操作了', () => {
    const result = evaluate(
      { danger: [dangerDelete] },
      { method: 'DELETE' },
      { isPreAuthorized: true }
    )

    expect(result.verdict.action).toBe('allow')
    expect(result.reason).toBe('pre_authorized')
  })

  it('3. 危险名单先于安全方法放行——危险的 GET 必须拦得住', () => {
    // GET 无副作用不等于安全：导出类接口会外泄数据。
    const result = evaluate(
      { danger: [{ id: 'danger-export', match: { url: '/api/export-all' }}] },
      { method: 'GET', url: 'https://app.example.com/api/export-all' }
    )

    expect(result.verdict).toMatchObject({
      action: 'confirm',
      risk: 'destructive',
      ruleId: 'danger-export'
    })
    expect(result.reason).toBe('danger_list')
  })

  it('4. Agent 发起的普通 GET 放行', () => {
    const result = evaluate({}, { method: 'GET' })

    expect(result.verdict.action).toBe('allow')
    expect(result.reason).toBe('safe_method')
  })

  it('4. defaultForSafeMethods 设为 confirm 时，GET 也要确认', () => {
    const result = evaluate({ defaultForSafeMethods: 'confirm' }, { method: 'GET' })

    expect(result.verdict).toMatchObject({ action: 'confirm', risk: 'write' })
  })

  it('5. 仅命中放行名单的写请求放行', () => {
    const result = evaluate(
      { allow: [{ id: 'allow-search', match: { method: 'POST', url: '/api/*/search' }}] },
      { method: 'POST', url: 'https://app.example.com/api/users/search' }
    )

    expect(result.verdict).toMatchObject({ action: 'allow', ruleId: 'allow-search' })
    expect(result.reason).toBe('allow_list')
  })

  it('6. 未命中任何名单的写请求默认要求确认（默认拒绝）', () => {
    const result = evaluate({}, { method: 'PUT' })

    expect(result.verdict).toMatchObject({ action: 'confirm', risk: 'write' })
    expect(result.reason).toBe('default_deny')
  })

  it('6. defaultForUnsafeMethods 设为 deny 时兜底改为拒绝', () => {
    const result = evaluate({ defaultForUnsafeMethods: 'deny' }, { method: 'PUT' })

    expect(result.verdict.action).toBe('deny')
    expect(result.reason).toBe('default_deny')
  })

  it('6. 未知方法按非安全方法处理', () => {
    const result = evaluate({}, { method: 'PROPFIND' })

    expect(result.verdict).toMatchObject({ action: 'confirm', risk: 'write' })
  })

  it('核心回归：同时命中放行名单与危险名单时，危险优先', () => {
    // 放行名单常写成宽泛通配，若让它先命中，一条粗糙规则就能把高危动作一并放过。
    const result = evaluate(
      { danger: [dangerDelete], allow: [allowAnyApi] },
      { method: 'DELETE' }
    )

    expect(result.verdict).toMatchObject({
      action: 'confirm',
      risk: 'destructive',
      ruleId: 'danger-delete-user'
    })
    expect(result.reason).toBe('danger_list')
  })

  it('危险名单的 when 返回 false 时退回后续判定，不强判 destructive', () => {
    const result = evaluate(
      {
        danger: [{
          id: 'danger-forced',
          match: { method: 'DELETE', when: req => (req.body as { force?: boolean })?.force === true }
        }],
        allow: [allowAnyApi]
      },
      { method: 'DELETE', body: { force: false }}
    )

    expect(result.verdict).toMatchObject({ action: 'allow', ruleId: 'allow-any-api' })
    expect(result.reason).toBe('allow_list')
  })
})

describe('evaluateRequest —— 规则求值出错时一律朝「更需要确认」倒', () => {
  it('危险规则的 when 抛错时视为命中，而不是降级放过', () => {
    const result = evaluate(
      {
        danger: [{
          id: 'danger-broken',
          match: { method: 'DELETE', when: () => { throw new Error('boom') }}
        }],
        allow: [allowAnyApi]
      },
      { method: 'DELETE' }
    )

    expect(result.verdict).toMatchObject({ action: 'confirm', risk: 'destructive' })
  })

  it('放行规则的 when 抛错时视为未命中，落到默认拒绝', () => {
    const result = evaluate(
      {
        allow: [{
          id: 'allow-broken',
          match: { method: 'POST', when: () => { throw new Error('boom') }}
        }]
      },
      { method: 'POST' }
    )

    expect(result.verdict).toMatchObject({ action: 'confirm', risk: 'write' })
    expect(result.reason).toBe('default_deny')
  })

  it('把规则求值异常上报给宿主，不静默吞掉', () => {
    const onRuleError = vi.fn()
    const error = new Error('boom')

    evaluateRequest({
      request: request({ method: 'DELETE' }),
      policy: {
        danger: [{ id: 'danger-broken', match: { when: () => { throw error }}}]
      },
      isAgentActive: true,
      isPreAuthorized: false,
      onRuleError
    })

    expect(onRuleError).toHaveBeenCalledWith('danger-broken', error)
  })
})

describe('RegExp URL 规则的确定性', () => {
  it.each([
    ['g', /\/api\/users\//g],
    ['y', /^https:\/\/app\.example\.com\/api\/users/y]
  ])('带 %s 标志的危险规则重复判定不会间歇性降级', (_flag, pattern) => {
    const policy: InterceptionPolicy = {
      danger: [{ id: 'danger-users', match: { url: pattern }}]
    }

    const reasons = [evaluate(policy), evaluate(policy), evaluate(policy)]
      .map(result => result.reason)

    expect(reasons).toEqual(['danger_list', 'danger_list', 'danger_list'])
  })

  it.each([
    ['g', /\/api\/users\//g],
    ['y', /^https:\/\/app\.example\.com\/api\/users/y]
  ])('带 %s 标志的正则不会被一次判定修改 lastIndex', (_flag, pattern) => {
    pattern.lastIndex = 7

    expect(matchesRequest(request(), { url: pattern })).toBe(true)
    expect(pattern.lastIndex).toBe(7)
  })

  it('RegExp 子类覆写 global getter 时仍按内部 g 状态稳定判定', () => {
    class HiddenGlobalRegExp extends RegExp {
      override get global(): boolean {
        return false
      }
    }
    const pattern = new HiddenGlobalRegExp('/api/users/', 'g')
    const policy: InterceptionPolicy = {
      danger: [{ id: 'danger-users', match: { url: pattern }}]
    }

    const reasons = [evaluate(policy), evaluate(policy), evaluate(policy)]
      .map(result => result.reason)

    expect(reasons).toEqual(['danger_list', 'danger_list', 'danger_list'])
    expect(pattern.lastIndex).toBe(0)
  })

  it('保留 RegExp 子类自定义 exec 的匹配语义', () => {
    class NeverMatchRegExp extends RegExp {
      override exec(_value: string): RegExpExecArray | null {
        return null
      }
    }
    const pattern = new NeverMatchRegExp('/api/users/', 'g')

    expect(matchesRequest(request(), { url: pattern })).toBe(false)
    expect(pattern.lastIndex).toBe(0)
  })
})

describe('matchesRequest', () => {
  it('方法匹配大小写不敏感', () => {
    expect(matchesRequest(request({ method: 'post' }), { method: 'POST' })).toBe(true)
  })

  it('方法可以给一组', () => {
    const matcher = { method: ['PUT', 'PATCH'] }
    expect(matchesRequest(request({ method: 'PATCH' }), matcher)).toBe(true)
    expect(matchesRequest(request({ method: 'POST' }), matcher)).toBe(false)
  })

  it('缺省的 method 与 url 表示不限', () => {
    expect(matchesRequest(request(), {})).toBe(true)
  })

  it('支持直接给 RegExp', () => {
    expect(matchesRequest(request(), { url: /\/api\/users\// })).toBe(true)
  })

  it('三项条件是合取关系', () => {
    expect(matchesRequest(request({ method: 'GET' }), {
      method: 'GET',
      url: '/api/users/:id',
      when: () => false
    })).toBe(false)
  })
})

describe('compileUrlPattern', () => {
  it('* 不跨越路径分隔符', () => {
    // 这条决定了放行规则的真实覆盖面：若 * 跨段，/api/* 就等于放行 /api 下的一切。
    const pattern = compileUrlPattern('/api/*/search')

    expect(pattern.test('/api/users/search')).toBe(true)
    expect(pattern.test('/api/v2/users/search')).toBe(false)
  })

  it('** 跨越路径分隔符', () => {
    const pattern = compileUrlPattern('/api/**')

    expect(pattern.test('/api/users')).toBe(true)
    expect(pattern.test('/api/v2/users/u_1')).toBe(true)
  })

  it(':param 匹配单个路径段', () => {
    const pattern = compileUrlPattern('/api/users/:id')

    expect(pattern.test('/api/users/u_1')).toBe(true)
    expect(pattern.test('/api/users/u_1/roles')).toBe(false)
  })

  it('整体锚定，前缀不算命中', () => {
    // 不锚定的话 /api 会匹配 /api/anything，宽泛放行规则会失控。
    const pattern = compileUrlPattern('/api/users')

    expect(pattern.test('/api/users')).toBe(true)
    expect(pattern.test('/api/users/u_1')).toBe(false)
    expect(pattern.test('/public/api/users')).toBe(false)
  })

  it('转义正则元字符，避免 . 被当成通配', () => {
    const pattern = compileUrlPattern('/api/users.json')

    expect(pattern.test('/api/users.json')).toBe(true)
    expect(pattern.test('/api/usersXjson')).toBe(false)
  })
})

describe('URL 匹配的比对目标', () => {
  it('以 / 开头的模式只比对 pathname，不受 origin 与 query 干扰', () => {
    const matcher = { url: '/api/users/:id' }

    expect(matchesRequest(
      request({ url: 'https://app.example.com/api/users/u_1?force=true' }),
      matcher
    )).toBe(true)
  })

  it('带协议的模式比对完整 URL，可用于区分不同后端', () => {
    expect(matchesRequest(
      request({ url: 'https://other.example.com/api/users/u_1' }),
      { url: 'https://app.example.com/**' }
    )).toBe(false)
  })
})

describe('findMatchingRule', () => {
  it('返回首条命中的规则', () => {
    const rules: RequestRule[] = [
      { id: 'first', match: { method: 'GET' }},
      { id: 'second', match: { method: 'DELETE' }},
      { id: 'third', match: { method: 'DELETE' }}
    ]

    expect(findMatchingRule(request({ method: 'DELETE' }), rules)?.id).toBe('second')
  })

  it('规则为空时返回 undefined', () => {
    expect(findMatchingRule(request(), undefined)).toBeUndefined()
    expect(findMatchingRule(request(), [])).toBeUndefined()
  })
})

describe('SAFE_METHODS', () => {
  it('只包含无副作用的方法', () => {
    expect([...SAFE_METHODS]).toEqual(['GET', 'HEAD', 'OPTIONS', 'TRACE'])
  })
})
