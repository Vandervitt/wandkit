import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  formatEvalSummaryMarkdown,
  summarizeAttempts,
  type EvalAttempt
} from './metrics'

export const BROWSER_PLUGIN_STATUS = 'Browser plugin not available'

export function resolveEvalOutputDir(): string {
  return process.env.PLAYWRIGHT_OUTPUT_DIR
    ? path.resolve(process.env.PLAYWRIGHT_OUTPUT_DIR)
    : fileURLToPath(new URL(
      '../../.playwright/网页任务完成率基线-20260802',
      import.meta.url
    ))
}

export async function writeLegacyReport(
  attempts: readonly EvalAttempt[]
): Promise<void> {
  const outputDir = resolveEvalOutputDir()
  const summary = summarizeAttempts(attempts)
  const metadata = {
    runner: 'legacy',
    browserPlugin: BROWSER_PLUGIN_STATUS,
    generatedAt: new Date().toISOString()
  }

  await mkdir(outputDir, { recursive: true })
  await Promise.all([
    writeFile(
      path.join(outputDir, 'legacy-attempts.json'),
      `${JSON.stringify({ metadata, attempts, summary }, null, 2)}\n`,
      'utf8'
    ),
    writeFile(
      path.join(outputDir, 'legacy-summary.md'),
      formatLegacyMarkdown(attempts, metadata, summary),
      'utf8'
    )
  ])
}

function formatLegacyMarkdown(
  attempts: readonly EvalAttempt[],
  metadata: { runner: string, browserPlugin: string, generatedAt: string },
  summary: ReturnType<typeof summarizeAttempts>
): string {
  const attemptRows = attempts.map(attempt => [
    attempt.scenarioId,
    attempt.category,
    attempt.passed ? '通过' : '失败',
    attempt.falseSuccess ? '是' : '否',
    String(attempt.steps),
    `${attempt.durationMs} ms`,
    attempt.failureCode ?? '-'
  ].map(escapeMarkdownCell).join(' | '))
  const summaryMarkdown = formatEvalSummaryMarkdown(summary).replace(
    '# 网页任务评估摘要',
    '# 旧 Runtime 网页任务完成率基线'
  )
  const [summaryHeading, ...summaryBody] = summaryMarkdown.split('\n')

  return [
    summaryHeading,
    '',
    `- Runner: ${metadata.runner}`,
    `- Browser: ${metadata.browserPlugin}`,
    `- Generated at: ${metadata.generatedAt}`,
    '',
    ...summaryBody,
    '## 场景明细',
    '',
    '| 场景 | 类别 | 结果 | 假成功 | 步骤 | 耗时 | 失败分类 |',
    '| --- | --- | --- | --- | ---: | ---: | --- |',
    ...attemptRows.map(row => `| ${row} |`),
    ''
  ].join('\n')
}

function escapeMarkdownCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ')
}
