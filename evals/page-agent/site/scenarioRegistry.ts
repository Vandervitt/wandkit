import { getPageAgentScenario } from '../scenarios'

export interface ScenarioEvaluation {
  readonly passed: boolean
  readonly falseSuccess: boolean
  readonly detail?: string
}

export interface MountedScenario {
  readonly id: string
  readonly task: string
  readonly evaluate: (answer: string) => ScenarioEvaluation
  readonly reset: () => void
  readonly dispose: () => void
}

interface ScenarioContext {
  readonly evalRoot: HTMLElement
  listen(
    target: EventTarget,
    type: string,
    listener: EventListener
  ): void
  schedule(callback: () => void, delay: number): void
  onCleanup(callback: () => void): void
}

interface ScenarioDefinition {
  mount(context: ScenarioContext): void
  evaluate(root: HTMLElement, answer: string): boolean
}

const activeMounts = new WeakMap<HTMLElement, MountedScenario>()

function element<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  attributes: Record<string, string> = {},
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tagName)
  for (const [name, value] of Object.entries(attributes)) {
    node.setAttribute(name, value)
  }
  if (text !== undefined) node.textContent = text
  return node
}

function appendLabelledInput(
  parent: HTMLElement,
  id: string,
  labelText: string,
  value = ''
): HTMLInputElement {
  const label = element('label', { for: id }, labelText)
  const input = element('input', { id })
  input.value = value
  parent.append(label, input)
  return input
}

function hasExplicitSuccessClaim(answer: string): boolean {
  const normalized = answer.replace(/\s+/g, '')
  const sentences =
    normalized.match(/[^。！!？?；;]+[。！!？?；;]?/g) ?? []
  let latestStatus: boolean | undefined

  for (const sentence of sentences) {
    if (/[?？]$/.test(sentence)) continue
    const sentenceBody = sentence.replace(/[。！!；;]$/, '')
    const clauses = sentenceBody.split(/[，,]+/).filter(Boolean)

    for (const clause of clauses) {
      if (/(?:是否|能否|有没有|请问|成功[了吗么]|完成[了吗么])/.test(clause)) {
        continue
      }

      const statusPattern = /((?:尚未|还未|未能|未|没有)(?:完成|成功|得到|获得|查到|进入|保存|创建|删除|设置|加载)|(?:无法|不能|失败|报错))|((?:已经|现已|已)(?:完成|成功|得到|获得|查到|进入|保存|创建|删除|设置|加载)|(?:操作|任务|查询|保存|创建|删除|导出)(?:已经|现已|已)?(?:完成|成功)(?![度率])|(?:完成|成功)了|得到(?:了)?结果|^(?:成功|完成)$)/g
      for (const match of clause.matchAll(statusPattern)) {
        latestStatus = match[2] !== undefined
      }
    }
  }

  return latestStatus === true
}

function currentEvalRoot(root: HTMLElement): HTMLElement | null {
  const evalRoots = root.querySelectorAll<HTMLElement>('[data-eval-root]')
  return evalRoots.length === 1 ? evalRoots[0] ?? null : null
}

const scenarioDefinitions: Readonly<Record<string, ScenarioDefinition>> = {
  'read-data': {
    mount({ evalRoot }) {
      const heading = element('h1', {}, '运营概览')
      const card = element('section')
      card.append(
        element('span', {}, '今日订单数'),
        element('strong', { 'data-order-count': '' }, '1842')
      )
      evalRoot.append(heading, card)
    },
    evaluate(root, answer) {
      return (
        root.querySelector('[data-order-count]')?.textContent?.trim() === '1842' &&
        answer.includes('1842')
      )
    }
  },
  navigation: {
    mount({ evalRoot, listen, onCleanup }) {
      const restoreInitialHash = (): void => {
        window.history.replaceState(
          window.history.state,
          '',
          `${window.location.pathname}${window.location.search}`
        )
      }
      restoreInitialHash()
      onCleanup(restoreInitialHash)

      const heading = element('h1', {}, '后台首页')
      const button = element('button', { type: 'button' }, '话单查询')
      listen(button, 'click', () => {
        window.location.hash = '#/cdr'
        heading.textContent = '话单查询'
      })
      evalRoot.append(heading, button)
    },
    evaluate(root) {
      return (
        window.location.hash === '#/cdr' &&
        root.querySelector('h1')?.textContent?.trim() === '话单查询'
      )
    }
  },
  'search-filter': {
    mount({ evalRoot, listen }) {
      const heading = element('h1', {}, '用户管理')
      const keyword = element('input', { 'aria-label': '关键词' })
      const search = element('button', { type: 'button' }, '查询')
      const table = element('table')
      const body = element('tbody')
      const users = ['张三', '李四']

      const renderRows = (names: readonly string[]): void => {
        body.replaceChildren(
          ...names.map(name => {
            const row = element('tr')
            row.append(element('td', {}, name))
            return row
          })
        )
      }

      renderRows(users)
      table.append(body)
      listen(search, 'click', () => {
        const value = keyword.value.trim()
        renderRows(users.filter(name => name.includes(value)))
      })
      evalRoot.append(heading, keyword, search, table)
    },
    evaluate(root) {
      const rows = Array.from(root.querySelectorAll('tbody tr'))
      return rows.length === 1 && rows[0]?.textContent?.trim() === '张三'
    }
  },
  form: {
    mount({ evalRoot, listen }) {
      const heading = element('h1', {}, '员工管理')
      const create = element('button', { type: 'button' }, '新建员工')
      const list = element('ul', { 'data-employee-list': '' })
      list.append(element('li', {}, '张三'))

      listen(create, 'click', () => {
        if (evalRoot.querySelector('form')) return

        const form = element('form')
        const name = appendLabelledInput(form, 'employee-name', '姓名')
        const save = element('button', { type: 'button' }, '保存')
        form.append(save)
        listen(save, 'click', () => {
          const value = name.value.trim()
          if (!value) return
          list.append(element('li', {}, value))
          form.remove()
        })
        evalRoot.append(form)
      })

      evalRoot.append(heading, create, list)
    },
    evaluate(root) {
      return Array.from(root.querySelectorAll('[data-employee-list] li')).some(
        item => item.textContent?.trim() === '王五'
      )
    }
  },
  'composite-select': {
    mount({ evalRoot, listen }) {
      const heading = element('h1', {}, '编辑员工王五')
      const role = element('input', {
        'aria-label': '角色',
        role: 'combobox',
        readonly: '',
        'aria-expanded': 'false'
      })
      role.readOnly = true
      role.value = '普通员工'

      listen(role, 'click', () => {
        if (evalRoot.querySelector('[role="listbox"]')) return

        const listbox = element('div', { role: 'listbox' })
        for (const option of ['普通员工', '管理员']) {
          const button = element(
            'button',
            { type: 'button', role: 'option' },
            option
          )
          listen(button, 'click', () => {
            role.value = option
            role.setAttribute('aria-expanded', 'false')
            listbox.remove()
          })
          listbox.append(button)
        }
        role.setAttribute('aria-expanded', 'true')
        evalRoot.append(listbox)
      })

      evalRoot.append(heading, role)
    },
    evaluate(root) {
      return (
        root.querySelector<HTMLInputElement>('input[aria-label="角色"]')?.value ===
        '管理员'
      )
    }
  },
  'rich-text': {
    mount({ evalRoot, listen }) {
      const heading = element('h1', {}, '编辑公告')
      const editor = element('div', {
        contenteditable: 'true',
        'aria-label': '公告正文'
      })
      const save = element('button', { type: 'button' }, '保存公告')
      const savedContent = element('div', { 'data-saved-content': '' })

      listen(save, 'click', () => {
        savedContent.textContent = editor.textContent ?? ''
      })
      evalRoot.append(heading, editor, save, savedContent)
    },
    evaluate(root) {
      return root.querySelector('[data-saved-content]')?.textContent === '季度总结'
    }
  },
  'validation-recovery': {
    mount({ evalRoot, listen }) {
      const heading = element('h1', {}, '新建联系人')
      const form = element('form')
      const name = appendLabelledInput(form, 'contact-name', '姓名', '赵六')
      const phone = appendLabelledInput(form, 'contact-phone', '手机号')
      const save = element('button', { type: 'button' }, '保存')
      const list = element('ul', { 'data-contact-list': '' })
      form.append(save)

      listen(save, 'click', () => {
        const validationError = form.querySelector('[role="alert"]')
        const recoveredFromValidationError =
          validationError?.textContent?.trim() === '手机号格式不正确'
        validationError?.remove()
        if (!/^1\d{10}$/.test(phone.value.trim())) {
          form.append(
            element('div', { role: 'alert' }, '手机号格式不正确')
          )
          return
        }

        const row = element('li')
        row.append(
          element('span', {}, name.value.trim()),
          element('span', {}, phone.value.trim())
        )
        if (recoveredFromValidationError) {
          row.setAttribute('data-validation-recovered', 'true')
        }
        list.replaceChildren(row)
      })

      evalRoot.append(heading, form, list)
    },
    evaluate(root) {
      if (root.querySelector('form [role="alert"]')) return false
      return Array.from(
        root.querySelectorAll(
          '[data-contact-list] li[data-validation-recovered="true"]'
        )
      ).some(item => {
        const content = item.textContent ?? ''
        return content.includes('赵六') && content.includes('13800138000')
      })
    }
  },
  'async-loading': {
    mount({ evalRoot, listen, schedule }) {
      const heading = element('h1', {}, '操作日志')
      const load = element('button', { type: 'button' }, '加载日志')
      const status = element('div', { 'data-log-status': '' })

      listen(load, 'click', () => {
        load.disabled = true
        status.textContent = '加载中'
        schedule(() => {
          status.textContent = '共 27 条'
          status.setAttribute('data-log-total', '27')
        }, 1500)
      })
      evalRoot.append(heading, load, status)
    },
    evaluate(root, answer) {
      return (
        root.querySelector('[data-log-total="27"]')?.textContent?.trim() ===
          '共 27 条' && answer.includes('27')
      )
    }
  },
  'ask-user': {
    mount({ evalRoot, listen }) {
      appendLabelledInput(evalRoot, 'start-date', '开始日期')
      appendLabelledInput(evalRoot, 'end-date', '结束日期')
      const exportButton = element('button', { type: 'button' }, '导出')

      listen(exportButton, 'click', () => {
        if (evalRoot.querySelector('[role="alert"]')) return
        evalRoot.append(element('div', { role: 'alert' }, '缺少日期范围'))
      })
      evalRoot.append(exportButton)
    },
    evaluate(root, answer) {
      const hasInputs =
        root.querySelector<HTMLInputElement>('#start-date')?.value === '' &&
        root.querySelector<HTMLInputElement>('#end-date')?.value === ''
      const exportNotTriggered = root.querySelector('[role="alert"]') === null
      const asksBothDates =
        answer.includes('开始日期') && answer.includes('结束日期')
      const asksDateRange = answer.includes('日期范围')
      const asksQuestion = /(?:请|提供|告诉|需要|哪|什么|\?|？)/.test(answer)

      return Boolean(
        hasInputs &&
          exportNotTriggered &&
          asksQuestion &&
          (asksBothDates || asksDateRange)
      )
    }
  },
  'dynamic-dom': {
    mount({ evalRoot, listen }) {
      const heading = element('h1', {}, '任务列表')
      const list = element('ul', { 'data-draft-list': '' })
      const draft = element('li')
      const draftName = element('span', {}, '过期草稿')
      const remove = element('button', { type: 'button' }, '删除')
      draft.append(draftName, remove)
      list.append(draft)

      listen(remove, 'click', () => {
        if (evalRoot.querySelector('[role="dialog"]')) return

        const firstDialog = element('div', { role: 'dialog' })
        const proceed = element('button', { type: 'button' }, '继续')
        firstDialog.append(proceed)
        evalRoot.append(firstDialog)

        listen(proceed, 'click', () => {
          const confirmationDialog = element('div', { role: 'dialog' })
          const confirm = element('button', { type: 'button' }, '确认')
          confirmationDialog.append(confirm)
          firstDialog.replaceWith(confirmationDialog)

          listen(confirm, 'click', () => {
            confirmationDialog.remove()
            draft.remove()
            evalRoot.append(element('div', { role: 'status' }, '删除成功'))
          })
        })
      })

      evalRoot.append(heading, list)
    },
    evaluate(root) {
      return (
        root.querySelector('[role="dialog"]') === null &&
        !(root.querySelector('[data-draft-list]')?.textContent ?? '').includes(
          '过期草稿'
        ) &&
        root.querySelector('[role="status"]')?.textContent?.trim() === '删除成功'
      )
    }
  }
}

export function mountScenario(id: string, root: HTMLElement): MountedScenario {
  const scenario = getPageAgentScenario(id)
  const definition = scenarioDefinitions[id]
  if (!definition) {
    throw new Error(`网页评估场景未实现: ${id}`)
  }

  activeMounts.get(root)?.dispose()

  let cleanups: Array<() => void> = []
  let disposed = false

  const cleanupResources = (): void => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  }

  const render = (): void => {
    cleanupResources()
    root.replaceChildren()
    const evalRoot = element('main', { 'data-eval-root': '', 'data-scenario': id })
    root.append(evalRoot)

    definition.mount({
      evalRoot,
      listen(target, type, listener) {
        target.addEventListener(type, listener)
        cleanups.push(() => target.removeEventListener(type, listener))
      },
      schedule(callback, delay) {
        const timer = window.setTimeout(callback, delay)
        cleanups.push(() => window.clearTimeout(timer))
      },
      onCleanup(callback) {
        cleanups.push(callback)
      }
    })
  }

  const mounted: MountedScenario = {
    id: scenario.id,
    task: scenario.task,
    evaluate(answer) {
      const evalRoot = currentEvalRoot(root)
      const passed = evalRoot ? definition.evaluate(evalRoot, answer) : false
      return {
        passed,
        falseSuccess: !passed && hasExplicitSuccessClaim(answer)
      }
    },
    reset() {
      if (disposed) return
      render()
    },
    dispose() {
      if (disposed) return
      disposed = true
      cleanupResources()
      root.replaceChildren()
      if (activeMounts.get(root) === mounted) activeMounts.delete(root)
    }
  }

  render()
  activeMounts.set(root, mounted)
  return mounted
}
