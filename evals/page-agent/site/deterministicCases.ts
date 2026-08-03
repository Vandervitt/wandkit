import type { LlmAssistantMessage } from '../../../packages/core/src/index'
import { finalAnswer, toolCall } from './scriptedLlm'

export interface LegacyDeterministicCase {
  readonly replies: readonly LlmAssistantMessage[]
}

export function createLegacyDeterministicCase(
  scenarioId: string
): LegacyDeterministicCase {
  switch (scenarioId) {
    case 'read-data':
      return {
        replies: [
          toolCall('page_read_v1', {}),
          finalAnswer('今日订单数为 1842。')
        ]
      }
    case 'navigation':
      return {
        replies: [
          toolCall('page_read_v1', {}),
          toolCall('page_click_v1', { index: 0 }),
          finalAnswer('已进入话单查询页面。')
        ]
      }
    case 'search-filter':
      return {
        replies: [
          toolCall('page_read_v1', {}),
          toolCall('page_input_v1', { index: 0, text: '张三' }),
          toolCall('page_click_v1', { index: 1 }),
          finalAnswer('已找到张三的用户记录。')
        ]
      }
    case 'form':
      return {
        replies: [
          toolCall('page_read_v1', {}),
          toolCall('page_click_v1', { index: 0 }),
          toolCall('page_input_v1', { index: 1, text: '王五' }),
          toolCall('page_click_v1', { index: 2 }),
          finalAnswer('王五员工已创建成功。')
        ]
      }
    case 'composite-select':
      return {
        replies: [
          toolCall('page_read_v1', {}),
          toolCall('page_select_v1', { index: 0, option: '管理员' }),
          toolCall('page_click_v1', { index: 1 }),
          finalAnswer('已将王五的角色设置为管理员。')
        ]
      }
    case 'rich-text':
      return {
        replies: [
          toolCall('page_read_v1', {}),
          toolCall('page_input_v1', { index: 0, text: '季度总结' }),
          toolCall('page_click_v1', { index: 1 }),
          finalAnswer('季度总结已写入并保存到公告正文。')
        ]
      }
    case 'validation-recovery':
      return {
        replies: [
          toolCall('page_read_v1', {}),
          toolCall('page_input_v1', { index: 1, text: '123' }),
          toolCall('page_click_v1', { index: 2 }),
          toolCall('page_input_v1', { index: 1, text: '13800138000' }),
          toolCall('page_click_v1', { index: 2 }),
          finalAnswer('赵六联系人已使用手机号 13800138000 创建成功。')
        ]
      }
    case 'async-loading':
      return {
        replies: [
          toolCall('page_read_v1', {}),
          toolCall('page_click_v1', { index: 0 }),
          toolCall('page_wait_v1', { text: '共 27 条', timeoutMs: 2000 }),
          toolCall('page_read_v1', {}),
          finalAnswer('操作日志共 27 条。')
        ]
      }
    case 'ask-user':
      return {
        replies: [finalAnswer('请提供需要导出的开始日期和结束日期。')]
      }
    case 'dynamic-dom':
      return {
        replies: [
          toolCall('page_read_v1', {}),
          toolCall('page_click_v1', { index: 0 }),
          toolCall('page_click_v1', { index: 1 }),
          toolCall('page_click_v1', { index: 1 }),
          finalAnswer('已删除过期草稿。')
        ]
      }
    default:
      throw new Error(`没有场景 ${scenarioId} 的旧 Runtime 确定性脚本`)
  }
}
