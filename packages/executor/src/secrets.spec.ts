/**
 * 凭据不得进入快照。
 *
 * 快照会被原样发给模型，从而离开浏览器、可能被厂商留存。本包的核心主张之一是
 * 「Key 与凭据永远不进前端链路」，快照泄漏密码等于把这条主张从背面拆掉。
 *
 * 这组用例源自真实浏览器上的实测——在 aicc-admin-front 的登录页跑快照时，密码
 * 以明文出现在了结果里。jsdom 夹具里没有密码框，测不出来。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { capturePage, formatSnapshot } from './snapshot'

function render(html: string): void {
  const parsed = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  document.body.replaceChildren(
    ...Array.from(parsed.body.childNodes).map(node => document.importNode(node, true))
  )
}

beforeEach(() => {
  document.body.replaceChildren()
})

describe('凭据脱敏', () => {
  it('password 类型的值不出现在快照里', () => {
    render('<input type="password" aria-label="密码" value="admin123">')

    const element = capturePage().elements[0]
    expect(element.value).not.toContain('admin123')
    expect(JSON.stringify(element)).not.toContain('admin123')
  })

  it('真实登录页的完整快照不含密码明文', () => {
    // 与 aicc-admin-front 登录页同构
    render(`
      <input type="text" aria-label="账号" value="aiccoperator">
      <input type="password" aria-label="密码" value="admin123">
      <input type="checkbox" aria-label="记住密码" checked>
      <button>登 录</button>
    `)

    expect(formatSnapshot(capturePage())).not.toContain('admin123')
  })

  it('仍然告诉模型该字段已填写，只是不给值', () => {
    // 完全隐藏会让模型以为密码框是空的，从而反复尝试填写。
    render('<input type="password" aria-label="密码" value="admin123">')

    expect(capturePage().elements[0].value).toBe('[已脱敏]')
  })

  it('空的密码框不产出值', () => {
    render('<input type="password" aria-label="密码" value="">')

    expect(capturePage().elements[0].value).toBeUndefined()
  })

  it('伪装成 text 的密码框也要脱敏（按 name 判定）', () => {
    render('<input type="text" name="password" value="admin123">')

    expect(capturePage().elements[0].value).toBe('[已脱敏]')
  })

  it('按 autocomplete 判定', () => {
    render('<input type="text" autocomplete="current-password" aria-label="口令" value="s3cret">')

    expect(capturePage().elements[0].value).toBe('[已脱敏]')
  })

  it('中文字样同样识别', () => {
    render('<input type="text" placeholder="请输入验证码" value="8842">')

    expect(capturePage().elements[0].value).toBe('[已脱敏]')
  })

  it('token / secret 字样识别', () => {
    render(`
      <input type="text" name="apiToken" value="sk-abc123">
      <input type="text" id="clientSecret" value="very-secret">
    `)

    expect(capturePage().elements.map(e => e.value)).toEqual(['[已脱敏]', '[已脱敏]'])
  })

  it('普通业务字段不受影响', () => {
    render(`
      <input type="text" aria-label="客户名称" value="国光科技">
      <input type="text" aria-label="手机号" value="13800138000">
    `)

    expect(capturePage().elements.map(e => e.value)).toEqual(['国光科技', '13800138000'])
  })
})
