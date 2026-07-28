import type { LlmMessage } from '../contracts/llm'

/**
 * 一轮内最多可以激活多少个模块。
 *
 * 定成 2 是刻意的。工具清单越长，模型选错的概率上升得越快，而绝大多数用户表述确实
 * 只涉及一个领域——第二个名额是留给跨模块场景（「查这个客户的通话」）的，不是用来
 * 给弱匹配兜底的。放大这个值是拿准确率换召回率，而在管理后台里，选错工具比没选到
 * 工具更糟。
 */
export const MAX_CANDIDATE_MODULES = 2

/** 一轮内发给模型的工具数硬上限，见 {@link selectToolsWithinBudget}。 */
export const MAX_EXPOSED_TOOLS = 12

/**
 * 组装后 Prompt 的字符预算。
 *
 * 按字符而非 token：数 token 需要与模型绑定的分词器，为了一道安全护栏把这么大的
 * 依赖塞进浏览器包并不划算。取值刻意保守——中日韩文本大致一字一 token，因此这个
 * 数字在最密的情况下依然成立。
 */
export const MAX_PROMPT_CHARS = 24000

/**
 * 从各模块的工具分组里轮转取数，最多取 `limit` 个。
 *
 * 上限真正咬合时，「轮转」和「拼接」的差别就出来了：拼接的话，工具多的那个模块会
 * 吃掉整个预算，第二个模块彻底消失，跨模块请求于是静默地变得不可能完成。轮转让两个
 * 模块均匀降级。
 *
 * 截断本身仍是有损的——分组靠后的工具会被丢掉——所以上限被咬合应当被视为「该拆模块
 * 了」的信号，而不是「该调大上限了」。
 */
export function selectToolsWithinBudget<T>(groups: readonly T[][], limit: number): T[] {
  if (limit <= 0) return []
  const selected: T[] = []
  const maxGroupLength = Math.max(0, ...groups.map(group => group.length))

  for (let index = 0; index < maxGroupLength && selected.length < limit; index += 1) {
    for (const group of groups) {
      const tool = group[index]
      if (tool !== undefined) selected.push(tool)
      if (selected.length >= limit) break
    }
  }

  return selected
}

/**
 * 裁剪会话历史以适配字符预算。
 *
 * 三条不变式，按优先级排列：
 *
 * 1. **所有 system 消息都保留。** 它们承载确认策略和时间锚点；丢掉任何一条都会
 *    静默改变模型行为。
 * 2. **最近一条 user 消息保留。** 把用户当前的请求本身裁掉是荒谬的。
 * 3. **assistant 的工具调用与其结果同进同退。** 见 {@link groupAtomicMessages}——
 *    这是协议硬要求，不是锦上添花。
 *
 * 其余内容按从新到旧准入，因为近几轮才携带当前请求依赖的指代（「那个」「第二行」）。
 *
 * 放不下的分组是跳过而不是终止循环，这样一个超大的历史轮次不会把排在它后面、
 * 更小更新的轮次一并挤掉。输出保持原始消息顺序。
 */
export function applyMessageBudget(
  messages: readonly LlmMessage[],
  maxChars = MAX_PROMPT_CHARS
): LlmMessage[] {
  const groups = groupAtomicMessages(messages)
  const latestUserIndex = findLatestUserIndex(messages)
  const requiredIndexes = new Set<number>()

  messages.forEach((message, index) => {
    if (message.role === 'system' || index === latestUserIndex) requiredIndexes.add(index)
  })

  const selectedIndexes = new Set(requiredIndexes)
  // 必留消息先计入，允许超出 maxChars。这是刻意的：它们不可协商，因此预算约束的是
  // 可选历史，而不是去砍策略本身。
  let usedChars = [...requiredIndexes]
    .reduce((total, index) => total + messageChars(messages[index]), 0)

  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index]
    if (group.some(messageIndex => requiredIndexes.has(messageIndex))) continue
    const groupChars = group.reduce(
      (total, messageIndex) => total + messageChars(messages[messageIndex]),
      0
    )
    if (usedChars + groupChars > maxChars) continue
    group.forEach(messageIndex => selectedIndexes.add(messageIndex))
    usedChars += groupChars
  }

  return messages.filter((_message, index) => selectedIndexes.has(index))
}

/** 最近一条 user 消息的下标，没有则为 -1。 */
function findLatestUserIndex(messages: readonly LlmMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') return index
  }
  return -1
}

/**
 * 把消息切成「要留一起留、要丢一起丢」的最小单元。
 *
 * 带 `tool_calls` 的 assistant 消息与回应这些 call id 的 tool 消息绑定在一起。
 * 工具调用协议要求每个 `tool_call_id` 都有对应的 tool 消息，因此只裁掉一半会产出
 * 一个厂商直接拒绝的请求——那是硬失败，不是质量下降。按 id 匹配（而非「后面 N 条」）
 * 保证了即使中间夹杂无关消息，配对依然正确。
 *
 * @returns 按序排列的原始下标分组。大多数消息各自成组。
 */
function groupAtomicMessages(messages: readonly LlmMessage[]): number[][] {
  const groups: number[][] = []
  let index = 0

  while (index < messages.length) {
    const message = messages[index]
    const group = [index]
    if (message.role === 'assistant' && message.tool_calls?.length) {
      const callIds = new Set(message.tool_calls.map(call => call.id))
      let nextIndex = index + 1
      while (nextIndex < messages.length) {
        const nextMessage = messages[nextIndex]
        if (nextMessage.role !== 'tool' || !callIds.has(nextMessage.tool_call_id)) break
        group.push(nextIndex)
        nextIndex += 1
      }
      index = nextIndex
    } else {
      index += 1
    }
    groups.push(group)
  }

  return groups
}

/**
 * 估算单条消息的字符成本。
 *
 * assistant 消息要额外算上工具调用的 id、名称和序列化后的参数，它们的体量经常远超
 * 可见文本——忽略这部分，几轮工具密集的对话就能把预算冲爆。
 */
function messageChars(message: LlmMessage): number {
  if (message.role === 'assistant') {
    return (message.content || '').length + (message.tool_calls || []).reduce((total, call) => {
      return total + call.id.length + call.function.name.length + call.function.arguments.length
    }, 0)
  }
  return message.content.length
}
