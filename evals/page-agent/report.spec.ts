import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink
} from 'node:fs/promises'
import { arch, homedir, platform, release, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { EvalAttempt } from './metrics'
import {
  resolveEvalOutputDir,
  resolvePlaywrightArtifactsDir,
  writeLegacyReport
} from './report'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const ALLOWED_ROOT = path.join(REPO_ROOT, '.playwright')
const DEFAULT_OUTPUT_DIR = path.join(
  ALLOWED_ROOT,
  '网页任务完成率基线-20260802'
)
const originalOutputDir = process.env.PLAYWRIGHT_OUTPUT_DIR
const cleanupTasks: Array<() => Promise<void>> = []

afterEach(async () => {
  if (originalOutputDir === undefined) {
    delete process.env.PLAYWRIGHT_OUTPUT_DIR
  } else {
    process.env.PLAYWRIGHT_OUTPUT_DIR = originalOutputDir
  }
  for (const cleanup of cleanupTasks.splice(0).reverse()) await cleanup()
})

describe('resolveEvalOutputDir', () => {
  it('缺省返回仓库 .playwright 下的固定基线目录', () => {
    delete process.env.PLAYWRIGHT_OUTPUT_DIR

    expect(resolveEvalOutputDir()).toBe(DEFAULT_OUTPUT_DIR)
  })

  it('接受仓库 .playwright 下的明确后代目录', () => {
    process.env.PLAYWRIGHT_OUTPUT_DIR = '.playwright/custom-run'

    expect(resolveEvalOutputDir()).toBe(path.join(ALLOWED_ROOT, 'custom-run'))
    expect(resolvePlaywrightArtifactsDir()).toBe(
      path.join(ALLOWED_ROOT, 'custom-run', 'test-artifacts')
    )
  })

  it.each([
    ['文件系统根目录', path.parse(REPO_ROOT).root],
    ['仓库根目录', REPO_ROOT],
    ['当前工作目录', process.cwd()],
    ['用户主目录', homedir()],
    ['.playwright 根目录', ALLOWED_ROOT],
    ['外部临时目录', path.join(tmpdir(), 'wandkit-outside')],
    ['相对路径越界', '.playwright/../outside']
  ])('拒绝%s', (_label, configuredPath) => {
    process.env.PLAYWRIGHT_OUTPUT_DIR = configuredPath

    expect(() => resolveEvalOutputDir()).toThrowError(
      /PLAYWRIGHT_OUTPUT_DIR 必须是仓库 \.playwright\/ 下的明确后代目录/
    )
  })

  it('拒绝候选路径中已存在的符号链接段', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'wandkit-report-outside-'))
    const link = path.join(ALLOWED_ROOT, `resolver-link-${randomUUID()}`)
    await mkdir(ALLOWED_ROOT, { recursive: true })
    await symlink(outside, link, 'dir')
    cleanupTasks.push(async () => rm(outside, { recursive: true, force: true }))
    cleanupTasks.push(async () => unlink(link))
    process.env.PLAYWRIGHT_OUTPUT_DIR = path.join(link, 'nested')

    expect(() => resolveEvalOutputDir()).toThrowError(/符号链接/)
  })

  it('拒绝固定 Playwright artifacts 子目录为符号链接', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'wandkit-artifacts-outside-'))
    const base = path.join(ALLOWED_ROOT, `artifacts-link-${randomUUID()}`)
    const artifactsLink = path.join(base, 'test-artifacts')
    await mkdir(base, { recursive: true })
    await symlink(outside, artifactsLink, 'dir')
    cleanupTasks.push(async () => rm(outside, { recursive: true, force: true }))
    cleanupTasks.push(async () => rm(base, { recursive: true, force: true }))
    process.env.PLAYWRIGHT_OUTPUT_DIR = base

    expect(resolveEvalOutputDir()).toBe(base)
    expect(() => resolvePlaywrightArtifactsDir()).toThrowError(/符号链接/)
  })
})

describe('writeLegacyReport', () => {
  it('写入可比较的环境 metadata，并转义 Markdown 表格字段', async () => {
    const relativeOutputDir = `.playwright/report-spec-${randomUUID()}`
    const outputDir = path.join(REPO_ROOT, relativeOutputDir)
    process.env.PLAYWRIGHT_OUTPUT_DIR = relativeOutputDir
    cleanupTasks.push(async () => rm(outputDir, { recursive: true, force: true }))
    const attempts: EvalAttempt[] = [{
      scenarioId: 'case|one\nnext',
      category: 'read_data',
      runner: 'legacy',
      passed: true,
      falseSuccess: false,
      durationMs: 12,
      steps: 1
    }]

    await writeLegacyReport(attempts, {
      browserName: 'chromium|nightly',
      browserVersion: '140.0\nbeta',
      browserExecutablePath:
        '/cache/ms-playwright/chromium_headless_shell-1193/chrome/headless_shell'
    })

    const report = JSON.parse(await readFile(
      path.join(outputDir, 'legacy-attempts.json'),
      'utf8'
    )) as { metadata: Record<string, unknown> }
    expect(report.metadata).toMatchObject({
      runner: 'legacy',
      nodeVersion: process.version,
      osPlatform: platform(),
      osArch: arch(),
      osRelease: release(),
      playwrightVersion: '1.55.1',
      browserName: 'chromium|nightly',
      browserVersion: '140.0\nbeta',
      chromiumBuild: '1193',
      browserPlugin: 'Browser plugin not available'
    })
    expect(report.metadata.gitRevision).toMatch(/^[0-9a-f]{40}$/)
    expect(report.metadata.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    const markdown = await readFile(
      path.join(outputDir, 'legacy-summary.md'),
      'utf8'
    )
    expect(markdown).toContain('| Browser name | chromium\\|nightly |')
    expect(markdown).toContain('| Browser version | 140.0 beta |')
    expect(markdown).toContain('| case\\|one next | read_data |')
  })
})
