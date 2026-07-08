import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { log } from '@stacksjs/logging'
import { Job } from '@stacksjs/queue'
import CheckResult from '../Models/CheckResult'
import Incident from '../Models/Incident'
import LighthouseReport from '../Models/LighthouseReport'
import Monitor from '../Models/Monitor'
import { parseMonitorConfig } from '../lib/monitorConfig'
import { broadcastMonitorUpdate } from '../Realtime/broadcastMonitorUpdate'

const SCORE_REGRESSION_THRESHOLD = 15 // percentage points

interface LighthouseCategories {
  performance?: { score: number | null }
  accessibility?: { score: number | null }
  seo?: { score: number | null }
  'best-practices'?: { score: number | null }
}

function runLighthouse(url: string, outputPath: string, device: 'mobile' | 'desktop'): Promise<{ code: number, stderr: string }> {
  return new Promise((resolve) => {
    const args = [
      'x',
      '--bun',
      'lighthouse',
      url,
      '--output=json',
      `--output-path=${outputPath}`,
      '--chrome-flags=--headless --no-sandbox --disable-gpu',
      '--quiet',
    ]
    // Mobile is Lighthouse's own default form factor, so we pass no flag for
    // it - the mobile audit stays byte-identical to before. `--preset=desktop`
    // sets form factor + screen emulation + throttling together; passing
    // `--form-factor=desktop` alone would leave a mobile screen emulation in
    // place and emit an emulation-mismatch warning that corrupts the scores.
    if (device === 'desktop')
      args.push('--preset=desktop')

    // process.execPath is the running bun binary: `bun x` is bunx without
    // depending on a `bunx` symlink existing on the worker's PATH (systemd
    // units get a minimal PATH; found in production as "Executable not
    // found in $PATH: bunx").
    const child = spawn(process.execPath, args)

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

    // Per-monitor device profile from the shared `config` JSON column, same
    // convention every other check job uses. Default 'mobile' matches
    // Lighthouse's own default, so existing monitors keep scoring as before.
    const device = parseMonitorConfig(monitor.config).device === 'desktop' ? 'desktop' : 'mobile'

    const startedAt = performance.now()
    const workDir = await mkdtemp(join(tmpdir(), 'lighthouse-'))
    const outputPath = join(workDir, 'report.json')
    const checkedAt = new Date().toISOString()

    try {
      const { code, stderr } = await runLighthouse(monitor.url, outputPath, device)

      if (code !== 0) {
        const chromeMissing = /could not find (a|any) chrome|no chrome installation/i.test(stderr)
        log.warn(chromeMissing
          ? `[job] RunLighthouseAudit: no Chrome/Chromium found on this host — Lighthouse audits require one to be installed (see stacksjs/status#1 Phase 4)`
          : `[job] RunLighthouseAudit: lighthouse exited ${code} for ${monitor.name}: ${stderr.slice(0, 500)}`)
        // A skipped audit is not a verdict, but last_checked_at must still
        // advance - DispatchDueChecks schedules off it, so returning without
        // it would re-dispatch a (typically daily) Lighthouse audit every
        // minute on a Chrome-less host. No CheckResult row: its status is
        // constrained to up/down/degraded and none of those fits a skip, so
        // the monitor keeps its current status and the message lives in the log.
        await monitor.update({ last_checked_at: checkedAt })
        // Push this check outcome to the live-status broadcaster so the
        // dashboard updates sub-second. Fire-and-forget; a no-op unless
        // Redis fan-out is enabled (the poller is the fallback).
        void broadcastMonitorUpdate(monitor.id)
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

      // A completed audit is 'up' unless it caught the performance
      // regression alerted on below - the site still loads, so that maps
      // to 'degraded' rather than 'down'.
      let status: 'up' | 'degraded' = 'up'
      let message = `Audit completed (performance ${performanceScore ?? 'n/a'})`

      if (
        previous?.performance_score != null
        && performanceScore != null
        && previous.performance_score - performanceScore >= SCORE_REGRESSION_THRESHOLD
      ) {
        status = 'degraded'
        message = `Performance score dropped from ${previous.performance_score} to ${performanceScore}`
        await Incident.create({
          monitor_id: monitor.id,
          started_at: checkedAt,
          cause: `Lighthouse performance score dropped from ${previous.performance_score} to ${performanceScore}`,
          status: 'monitoring',
          impacted_checks: JSON.stringify([{ type: 'lighthouse', previous: previous.performance_score, current: performanceScore }]),
        })
        log.warn(`[job] RunLighthouseAudit: ${monitor.name} performance regressed ${previous.performance_score} -> ${performanceScore}`)
      }

      await CheckResult.create({
        monitor_id: monitor.id,
        status,
        response_time_ms: Math.round(performance.now() - startedAt),
        status_code: 0,
        message,
        metadata: JSON.stringify({ performanceScore, accessibilityScore, seoScore, bestPracticesScore, device }),
        region: process.env.WORKER_REGION || 'default',
        checked_at: checkedAt,
      })

      // last_checked_at must advance on every terminal path - DispatchDueChecks
      // schedules off it, so skipping it would re-dispatch this check every minute.
      const consecutiveFailures = status === 'up' ? 0 : monitor.consecutive_failures + 1
      await monitor.update({ status, last_checked_at: checkedAt, consecutive_failures: consecutiveFailures })
      void broadcastMonitorUpdate(monitor.id)
    }
    catch (error) {
      log.warn(`[job] RunLighthouseAudit: failed for ${monitor.name}: ${error instanceof Error ? error.message : String(error)}`)
      // Same constraint as the non-zero-exit path above: no verdict, but
      // last_checked_at still has to move so the audit isn't re-dispatched
      // every minute.
      await monitor.update({ last_checked_at: checkedAt })
      void broadcastMonitorUpdate(monitor.id)
    }
    finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => {})
    }
  },
})
