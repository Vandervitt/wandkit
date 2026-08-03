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
import type { OpenAICompatibleExchange } from './site/openAICompatibleLlm'

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
  readonly gitDirty: boolean
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

export interface RealReportAttempt {
  readonly attempt: number
  readonly result: EvalAttempt
}

export interface RealReportExchangeRecord {
  readonly scenarioId: string
  readonly attempt: number
  readonly exchanges: readonly OpenAICompatibleExchange[]
}

export interface RealReportOptions extends LegacyReportBrowserMetadata {
  readonly runId: string
  readonly model: string
  readonly repetitions: number
  readonly maxRounds: number
  readonly scenarioIds: readonly string[]
  readonly endpoint: string
  readonly exchanges: readonly RealReportExchangeRecord[]
}

export interface RealReportFiles {
  readonly json: string
  readonly markdown: string
  readonly exchanges: string
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
    gitDirty: gitDirty(),
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

export async function writeRealReport(
  records: readonly RealReportAttempt[],
  options: RealReportOptions
): Promise<RealReportFiles> {
  const outputDir = resolveEvalOutputDir()
  const attempts = records.map(record => ({
    ...record.result,
    attempt: record.attempt
  }))
  const summary = summarizeAttempts(records.map(record => record.result))
  const chromiumBuild = extractChromiumBuild(options.browserExecutablePath)
  const metadata = {
    runner: 'legacy' as const,
    mode: 'real' as const,
    gitRevision: gitRevision(),
    gitDirty: gitDirty(),
    nodeVersion: process.version,
    osPlatform: platform(),
    osArch: arch(),
    osRelease: release(),
    playwrightVersion: playwrightPackage.version,
    browserName: options.browserName,
    browserVersion: options.browserVersion,
    ...(chromiumBuild === undefined ? {} : { chromiumBuild }),
    browserPlugin: BROWSER_PLUGIN_STATUS,
    model: options.model,
    repetitions: options.repetitions,
    maxRounds: options.maxRounds,
    scenarioIds: [...options.scenarioIds],
    endpoint: safeEndpointForReport(options.endpoint),
    runId: options.runId,
    generatedAt: new Date().toISOString()
  }
  const stem = `legacy-real-${safeFileComponent(options.model)}-${
    safeFileComponent(options.runId)
  }`
  const files: RealReportFiles = {
    json: path.join(outputDir, `${stem}-attempts.json`),
    markdown: path.join(outputDir, `${stem}-summary.md`),
    exchanges: path.join(outputDir, `${stem}-exchanges.json`)
  }

  await mkdir(outputDir, { recursive: true })
  await Promise.all([
    writeFile(
      files.json,
      `${JSON.stringify({ metadata, attempts, summary }, null, 2)}\n`,
      'utf8'
    ),
    writeFile(
      files.markdown,
      formatRealMarkdown(records, metadata, summary),
      'utf8'
    ),
    writeFile(
      files.exchanges,
      `${JSON.stringify({
        metadata: {
          runId: options.runId,
          model: options.model,
          maxRounds: options.maxRounds
        },
        attempts: options.exchanges
      }, null, 2)}\n`,
      'utf8'
    )
  ])
  return files
}

function formatRealMarkdown(
  records: readonly RealReportAttempt[],
  metadata: {
    readonly runner: 'legacy'
    readonly mode: 'real'
    readonly gitDirty: boolean
    readonly model: string
    readonly repetitions: number
    readonly maxRounds: number
    readonly scenarioIds: readonly string[]
    readonly endpoint: string
    readonly runId: string
    readonly generatedAt: string
    readonly browserName: string
    readonly browserVersion: string
  },
  summary: ReturnType<typeof summarizeAttempts>
): string {
  const summaryMarkdown = formatEvalSummaryMarkdown(summary).replace(
    '# 网页任务评估摘要',
    '# 旧 Runtime 真实模型网页任务完成率基线'
  )
  const [summaryHeading, ...summaryBody] = summaryMarkdown.split('\n')
  const environmentRows = [
    ['Runner', metadata.runner],
    ['Mode', metadata.mode],
    ['Git dirty', String(metadata.gitDirty)],
    ['Model', metadata.model],
    ['Repetitions', String(metadata.repetitions)],
    ['Max rounds per attempt', String(metadata.maxRounds)],
    ['Scenarios', metadata.scenarioIds.join(', ')],
    ['Endpoint', metadata.endpoint],
    ['Run ID', metadata.runId],
    ['Browser name', metadata.browserName],
    ['Browser version', metadata.browserVersion],
    ['Generated at', metadata.generatedAt]
  ].map(([label, value]) => `| ${escapeMarkdownCell(label ?? '')} | ${
    escapeMarkdownCell(value ?? '')
  } |`)
  const attemptRows = records.map(record => {
    const result = record.result
    return [
      result.scenarioId,
      String(record.attempt),
      result.model ?? metadata.model,
      result.category,
      result.passed ? '通过' : '失败',
      result.falseSuccess ? '是' : '否',
      String(result.steps),
      `${result.durationMs} ms`,
      result.failureCode ?? '-'
    ].map(escapeMarkdownCell).join(' | ')
  })

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
    '| 场景 | Attempt | Model | 类别 | 结果 | 假成功 | 步骤 | 耗时 | 失败分类 |',
    '| --- | ---: | --- | --- | --- | --- | ---: | ---: | --- |',
    ...attemptRows.map(row => `| ${row} |`),
    ''
  ].join('\n')
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
    ['Git dirty', String(metadata.gitDirty)],
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

function gitDirty(): boolean {
  return readGitDirty(REPO_ROOT)
}

export function readGitDirty(repoRoot: string): boolean {
  return execFileSync(
    'git',
    ['status', '--porcelain'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }
  ).trim() !== ''
}

function extractChromiumBuild(executablePath?: string): string | undefined {
  return executablePath?.match(
    /(?:chromium(?:_headless_shell)?)-(\d+)(?:[/\\]|$)/
  )?.[1]
}

function safeEndpointForReport(endpoint: string): string {
  const url = new URL(endpoint)
  url.username = ''
  url.password = ''
  url.search = ''
  url.hash = ''
  return url.toString()
}

function safeFileComponent(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'unknown'
}
