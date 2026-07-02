import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { log } from '@stacksjs/logging'
import { Job } from '@stacksjs/queue'
import Incident from '../Models/Incident'
import LighthouseReport from '../Models/LighthouseReport'
import Monitor from '../Models/Monitor'

const SCORE_REGRESSION_THRESHOLD = 15 // percentage points

interface LighthouseCategories {
  performance?: { score: number | null }
  accessibility?: { score: number | null }
  seo?: { score: number | null }
  'best-practices'?: { score: number | null }
}

function runLighthouse(url: string, outputPath: string): Promise<{ code: number, stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('bunx', [
      '--bun',
      'lighthouse',
      url,
      '--output=json',
      `--output-path=${outputPath}`,
      '--chrome-flags=--headless --no-sandbox --disable-gpu',
      '--quiet',
    ])

    let stderr = ''
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('close', code => resolve({ code: code ?? 1, stderr }))
    child.on('error', err => resolve({ code: 1, stderr: err.message }))
  })
}

/**
 * Runs a real Lighthouse audit against a monitor's URL. This is the one
 * check type that needs a real browser (Lighthouse launches headless
 * Chrome via chrome-launcher) — it's slow (seconds, not milliseconds) and
 * resource-heavy compared to every other check job here, so it belongs on
 * its own queue with its own concurrency limit (see stacksjs/status#1
 * Phase 11), not sharing a worker pool with the lightweight HTTP checks.
 *
 * Requires Chrome or Chromium on the worker host — this is an operational
 * prerequisite for this check type specifically, not something the job
 * installs on demand. When it's missing, this fails loudly in the log
 * (once per run, not as a crash) rather than silently producing no report.
 */
export default new Job({
  name: 'RunLighthouseAudit',
  description: 'Run a Lighthouse audit for a monitor',
  queue: 'lighthouse',
  tries: 1,
  timeout: 120,

  async handle(payload: { monitorId: number }) {
    const monitor = await Monitor.find(payload.monitorId)
    if (!monitor) {
      log.warn(`[job] RunLighthouseAudit: monitor ${payload.monitorId} not found`)
      return
    }

    const workDir = await mkdtemp(join(tmpdir(), 'lighthouse-'))
    const outputPath = join(workDir, 'report.json')
    const checkedAt = new Date().toISOString()

    try {
      const { code, stderr } = await runLighthouse(monitor.url, outputPath)

      if (code !== 0) {
        const chromeMissing = /could not find (a|any) chrome|no chrome installation/i.test(stderr)
        log.warn(chromeMissing
          ? `[job] RunLighthouseAudit: no Chrome/Chromium found on this host — Lighthouse audits require one to be installed (see stacksjs/status#1 Phase 4)`
          : `[job] RunLighthouseAudit: lighthouse exited ${code} for ${monitor.name}: ${stderr.slice(0, 500)}`)
        return
      }

      const raw = await readFile(outputPath, 'utf8')
      const report = JSON.parse(raw) as { categories?: LighthouseCategories }
      const categories = report.categories ?? {}

      const toPercent = (score: number | null | undefined): number | null =>
        typeof score === 'number' ? Math.round(score * 100) : null

      const performanceScore = toPercent(categories.performance?.score)
      const accessibilityScore = toPercent(categories.accessibility?.score)
      const seoScore = toPercent(categories.seo?.score)
      const bestPracticesScore = toPercent(categories['best-practices']?.score)

      const previous = await LighthouseReport.where('monitor_id', monitor.id).orderByDesc('created_at').first()

      await LighthouseReport.create({
        monitor_id: monitor.id,
        performance_score: performanceScore,
        accessibility_score: accessibilityScore,
        seo_score: seoScore,
        best_practices_score: bestPracticesScore,
        report_json: raw,
        checked_at: checkedAt,
      })

      if (
        previous?.performance_score != null
        && performanceScore != null
        && previous.performance_score - performanceScore >= SCORE_REGRESSION_THRESHOLD
      ) {
        await Incident.create({
          monitor_id: monitor.id,
          started_at: checkedAt,
          cause: `Lighthouse performance score dropped from ${previous.performance_score} to ${performanceScore}`,
          status: 'monitoring',
          impacted_checks: JSON.stringify([{ type: 'lighthouse', previous: previous.performance_score, current: performanceScore }]),
        })
        log.warn(`[job] RunLighthouseAudit: ${monitor.name} performance regressed ${previous.performance_score} -> ${performanceScore}`)
      }
    }
    catch (error) {
      log.warn(`[job] RunLighthouseAudit: failed for ${monitor.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
    finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => {})
    }
  },
})
