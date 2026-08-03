import { lstatSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { arch, homedir, platform, release } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  formatEvalSummaryMarkdown,
  summarizeAttempts,
  type EvalAttempt
} from './metrics'

export const BROWSER_PLUGIN_STATUS = 'Browser plugin not available'
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const PLAYWRIGHT_ROOT = path.join(REPO_ROOT, '.playwright')
const DEFAULT_OUTPUT_DIR = path.join(
  PLAYWRIGHT_ROOT,
  '网页任务完成率基线-20260802'
)
const require = createRequire(import.meta.url)
const playwrightPackage = require('@playwright/test/package.json') as {
  version: string
}

export interface LegacyReportBrowserMetadata {
  readonly browserName: string
  readonly browserVersion: string
  readonly browserExecutablePath?: string
}

export interface LegacyReportMetadata {
  readonly runner: 'legacy'
  readonly gitRevision: string
  readonly nodeVersion: string
  readonly osPlatform: string
  readonly osArch: string
  readonly osRelease: string
  readonly playwrightVersion: string
  readonly browserName: string
  readonly browserVersion: string
  readonly chromiumBuild?: string
  readonly browserPlugin: typeof BROWSER_PLUGIN_STATUS
  readonly generatedAt: string
}

export function resolveEvalOutputDir(): string {
  const configured = process.env.PLAYWRIGHT_OUTPUT_DIR
  const candidate = configured
    ? path.resolve(REPO_ROOT, configured)
    : DEFAULT_OUTPUT_DIR

  assertSafePlaywrightDescendant(candidate)
  return candidate
}

export function resolvePlaywrightArtifactsDir(): string {
  const candidate = path.join(resolveEvalOutputDir(), 'test-artifacts')
  assertSafePlaywrightDescendant(candidate)
  return candidate
}

function assertSafePlaywrightDescendant(candidate: string): void {
  const relative = path.relative(PLAYWRIGHT_ROOT, candidate)
  if (
    candidate === path.parse(candidate).root ||
    candidate === path.resolve(homedir()) ||
    candidate === path.resolve(process.cwd()) ||
    candidate === REPO_ROOT ||
    candidate === PLAYWRIGHT_ROOT ||
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      'PLAYWRIGHT_OUTPUT_DIR 必须是仓库 .playwright/ 下的明确后代目录'
    )
  }

  assertNoExistingSymlink(PLAYWRIGHT_ROOT, candidate)
}

function assertNoExistingSymlink(root: string, candidate: string): void {
  const segments = path.relative(root, candidate).split(path.sep).filter(Boolean)
  let current = root

  for (const segment of ['', ...segments]) {
    if (segment) current = path.join(current, segment)
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error(`评估输出目录不能包含符号链接: ${current}`)
      }
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return
      }
      throw error
    }
  }
}

export async function writeLegacyReport(
  attempts: readonly EvalAttempt[],
  browser: LegacyReportBrowserMetadata
): Promise<void> {
  const outputDir = resolveEvalOutputDir()
  const summary = summarizeAttempts(attempts)
  const chromiumBuild = extractChromiumBuild(browser.browserExecutablePath)
  const metadata: LegacyReportMetadata = {
    runner: 'legacy' as const,
    gitRevision: gitRevision(),
    nodeVersion: process.version,
    osPlatform: platform(),
    osArch: arch(),
    osRelease: release(),
    playwrightVersion: playwrightPackage.version,
    browserName: browser.browserName,
    browserVersion: browser.browserVersion,
    ...(chromiumBuild === undefined ? {} : { chromiumBuild }),
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
  metadata: LegacyReportMetadata,
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
  const environmentRows = [
    ['Runner', metadata.runner],
    ['Git revision', metadata.gitRevision],
    ['Node.js', metadata.nodeVersion],
    ['OS platform', metadata.osPlatform],
    ['OS arch', metadata.osArch],
    ['OS release', metadata.osRelease],
    ['Playwright', metadata.playwrightVersion],
    ['Browser name', metadata.browserName],
    ['Browser version', metadata.browserVersion],
    ['Chromium build', metadata.chromiumBuild ?? '-'],
    ['Browser plugin', metadata.browserPlugin],
    ['Generated at', metadata.generatedAt]
  ].map(([label, value]) => `| ${escapeMarkdownCell(label ?? '')} | ${
    escapeMarkdownCell(value ?? '')
  } |`)

  return [
    summaryHeading,
    '',
    '## 环境',
    '',
    '| 项目 | 值 |',
    '| --- | --- |',
    ...environmentRows,
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

function gitRevision(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  }).trim()
}

function extractChromiumBuild(executablePath?: string): string | undefined {
  return executablePath?.match(
    /(?:chromium(?:_headless_shell)?)-(\d+)(?:[/\\]|$)/
  )?.[1]
}
