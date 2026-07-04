import { config } from '@stacksjs/config'
import { mail } from '@stacksjs/email'
import { log } from '@stacksjs/logging'
import { Job } from '@stacksjs/queue'
import Team from '../../storage/framework/defaults/app/Models/Team'
import CheckResult from '../Models/CheckResult'
import Crawl from '../Models/Crawl'
import Incident from '../Models/Incident'
import Monitor from '../Models/Monitor'

const DAY_MS = 24 * 60 * 60 * 1000

// A p95 change of more than 15% versus the previous window is called out
// as improved/degraded; anything within that band reads as steady. 15%
// keeps ordinary run-to-run noise from flip-flopping the arrow every
// report while still surfacing real shifts.
const TREND_THRESHOLD = 0.15

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

type Trend = 'improved' | 'steady' | 'degraded' | 'n/a'

interface MonitorReport {
  name: string
  url: string
  checkCount: number
  upCount: number
  uptimePct: number | null
  avgMs: number | null
  p95Ms: number | null
  trend: Trend
}

// Same percentile approach as CheckPerformanceTrends: nearest-rank on a
// pre-sorted ascending array.
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[index]!
}

/**
 * Due-detection, evaluated per team from its own row so the job can run
 * daily (see app/Scheduler.ts) and still send exactly one report per
 * period:
 * - monthly: due on the 1st of the month (UTC), or as a catch-up when
 *   report_last_sent_at is more than 32 days old (covers a scheduler
 *   outage spanning the 1st).
 * - weekly: due on Mondays (UTC), or as a catch-up when last sent more
 *   than 8 days ago.
 * Either way, a report sent within the last 27 days (monthly) / 6 days
 * (weekly) means this period is already covered, so a second run on the
 * same day (queue retry, manual dispatch, overlapping worker) is a no-op.
 */
function isDue(frequency: string, lastSentAt: string | null, now: Date): boolean {
  const lastMs = lastSentAt ? Date.parse(lastSentAt) : Number.NaN
  const hasLast = Number.isFinite(lastMs)
  const age = hasLast ? now.getTime() - lastMs : Number.POSITIVE_INFINITY

  if (frequency === 'monthly') {
    const dayGate = now.getUTCDate() === 1
    const catchUp = hasLast && age > 32 * DAY_MS
    if (!dayGate && !catchUp) return false
    return !hasLast || age > 27 * DAY_MS
  }

  if (frequency === 'weekly') {
    const dayGate = now.getUTCDay() === 1 // Monday
    const catchUp = hasLast && age > 8 * DAY_MS
    if (!dayGate && !catchUp) return false
    return !hasLast || age > 6 * DAY_MS
  }

  return false
}

// Reporting window in epoch ms: previous calendar month for monthly,
// the previous 7 full UTC days (ending at today 00:00 UTC) for weekly.
function reportWindow(frequency: string, now: Date): { start: number, end: number } {
  if (frequency === 'monthly') {
    const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)
    const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
    return { start, end }
  }
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  return { start: end - 7 * DAY_MS, end }
}

function periodLabel(frequency: string, start: number, end: number): string {
  const s = new Date(start)
  if (frequency === 'monthly')
    return `${MONTH_NAMES[s.getUTCMonth()]} ${s.getUTCFullYear()}`
  const e = new Date(end - DAY_MS) // the last full day the window covers
  return `${MONTH_SHORT[s.getUTCMonth()]} ${s.getUTCDate()} to ${MONTH_SHORT[e.getUTCMonth()]} ${e.getUTCDate()}, ${e.getUTCFullYear()}`
}

function formatDuration(ms: number): string {
  if (ms <= 0) return '0m'
  const minutes = Math.round(ms / 60000)
  const hours = Math.floor(minutes / 60)
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  return `${minutes}m`
}

function formatUptime(pct: number | null): string {
  return pct === null ? 'no data' : `${pct.toFixed(2)}%`
}

function formatMs(ms: number | null): string {
  return ms === null ? '-' : `${Math.round(ms)}ms`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function trendLabel(trend: Trend): { symbol: string, word: string, color: string } {
  if (trend === 'improved') return { symbol: '&#9660;', word: 'improved', color: '#059669' }
  if (trend === 'degraded') return { symbol: '&#9650;', word: 'degraded', color: '#dc2626' }
  if (trend === 'steady') return { symbol: '&#8594;', word: 'steady', color: '#6b7280' }
  return { symbol: '', word: '-', color: '#9ca3af' }
}

interface TeamReport {
  teamName: string
  label: string
  monitors: MonitorReport[]
  incidentCount: number
  incidentDurationMs: number
  crawlsCompleted: number
  brokenLinks: number
  mixedContent: number
}

function buildHtml(report: TeamReport, appName: string): string {
  const totalChecks = report.monitors.reduce((sum, m) => sum + m.checkCount, 0)
  const totalUp = report.monitors.reduce((sum, m) => sum + m.upCount, 0)
  const overallUptime = totalChecks > 0 ? (totalUp / totalChecks) * 100 : null

  const cell = 'padding:10px 12px;font-size:13px;color:#111827;border-bottom:1px solid #e5e7eb;'
  const head = 'padding:8px 12px;font-size:11px;font-weight:bold;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;text-align:left;border-bottom:2px solid #059669;'

  const monitorRows = report.monitors.map((m) => {
    const t = trendLabel(m.trend)
    return `<tr>`
      + `<td style="${cell}"><strong>${escapeHtml(m.name)}</strong><br /><span style="font-size:11px;color:#6b7280;">${escapeHtml(m.url)}</span></td>`
      + `<td style="${cell}text-align:right;">${formatUptime(m.uptimePct)}</td>`
      + `<td style="${cell}text-align:right;">${m.checkCount}</td>`
      + `<td style="${cell}text-align:right;">${formatMs(m.avgMs)}</td>`
      + `<td style="${cell}text-align:right;">${formatMs(m.p95Ms)}</td>`
      + `<td style="${cell}text-align:right;color:${t.color};">${t.symbol} ${t.word}</td>`
      + `</tr>`
  }).join('')

  const monitorsTable = report.monitors.length > 0
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">`
      + `<tr><th style="${head}">Monitor</th><th style="${head}text-align:right;">Uptime</th><th style="${head}text-align:right;">Checks</th><th style="${head}text-align:right;">Avg</th><th style="${head}text-align:right;">p95</th><th style="${head}text-align:right;">Trend</th></tr>`
      + monitorRows
      + `</table>`
    : `<p style="margin:0;font-size:13px;color:#6b7280;">No monitors on this team yet.</p>`

  const statBox = (label: string, value: string) =>
    `<td width="25%" style="padding:12px;text-align:center;background-color:#f9fafb;border-radius:6px;">`
    + `<div style="font-size:20px;font-weight:bold;color:#111827;">${value}</div>`
    + `<div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;padding-top:4px;">${label}</div>`
    + `</td>`

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f3f4f6;padding:24px 0;">`
    + `<tr><td align="center">`
    + `<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background-color:#ffffff;border-radius:8px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;">`
    + `<tr><td style="background-color:#059669;padding:20px 24px;">`
    + `<div style="font-size:18px;font-weight:bold;color:#ffffff;">${escapeHtml(appName)} uptime report</div>`
    + `<div style="font-size:13px;color:#d1fae5;padding-top:4px;">${escapeHtml(report.teamName)} &middot; ${escapeHtml(report.label)}</div>`
    + `</td></tr>`
    + `<tr><td style="padding:20px 24px 8px 24px;">`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="8"><tr>`
    + statBox('Uptime', formatUptime(overallUptime))
    + statBox('Checks', String(totalChecks))
    + statBox('Incidents', String(report.incidentCount))
    + statBox('Downtime', formatDuration(report.incidentDurationMs))
    + `</tr></table>`
    + `</td></tr>`
    + `<tr><td style="padding:12px 24px;">${monitorsTable}</td></tr>`
    + `<tr><td style="padding:8px 24px 4px 24px;">`
    + `<div style="font-size:13px;color:#111827;"><strong>Incidents:</strong> ${report.incidentCount === 0 ? 'none in this period.' : `${report.incidentCount}, total duration ${formatDuration(report.incidentDurationMs)}.`}</div>`
    + `</td></tr>`
    + `<tr><td style="padding:4px 24px 16px 24px;">`
    + `<div style="font-size:13px;color:#111827;"><strong>Crawl findings:</strong> ${report.crawlsCompleted} crawl${report.crawlsCompleted === 1 ? '' : 's'} completed, ${report.brokenLinks} broken link${report.brokenLinks === 1 ? '' : 's'}, ${report.mixedContent} mixed content issue${report.mixedContent === 1 ? '' : 's'}.</div>`
    + `</td></tr>`
    + `<tr><td style="padding:16px 24px;border-top:1px solid #e5e7eb;">`
    + `<div style="font-size:11px;color:#9ca3af;">You are receiving this because uptime reports are enabled for ${escapeHtml(report.teamName)}. Manage this in the dashboard under Settings, Team.</div>`
    + `</td></tr>`
    + `</table>`
    + `</td></tr></table>`
}

function buildText(report: TeamReport, appName: string): string {
  const lines = [
    `${appName} uptime report`,
    `${report.teamName}, ${report.label}`,
    '',
  ]

  if (report.monitors.length === 0) {
    lines.push('No monitors on this team yet.')
  }
  else {
    for (const m of report.monitors) {
      lines.push(`- ${m.name} (${m.url}): uptime ${formatUptime(m.uptimePct)}, ${m.checkCount} checks, avg ${formatMs(m.avgMs)}, p95 ${formatMs(m.p95Ms)}, trend ${m.trend}`)
    }
  }

  lines.push('')
  lines.push(report.incidentCount === 0
    ? 'Incidents: none in this period.'
    : `Incidents: ${report.incidentCount}, total duration ${formatDuration(report.incidentDurationMs)}.`)
  lines.push(`Crawl findings: ${report.crawlsCompleted} crawls completed, ${report.brokenLinks} broken links, ${report.mixedContent} mixed content issues.`)
  lines.push('')
  lines.push(`You are receiving this because uptime reports are enabled for ${report.teamName}.`)

  return lines.join('\n')
}

/**
 * Periodic per-team uptime report emails (client-ready summaries, the
 * feature Oh Dear markets as monthly reports). Scheduled daily (see
 * app/Scheduler.ts); each run decides which teams are due from
 * teams.report_frequency + report_last_sent_at (migration 0000000195),
 * so the schedule stays a dumb daily tick and dueness lives in one place.
 */
export default new Job({
  name: 'SendUptimeReports',
  description: 'Email periodic uptime reports to teams that opted in',
  queue: 'notifications',
  // tries: 1 on purpose. A partial failure is retried naturally by the
  // next daily run (the catch-up branch of isDue); a queue-level retry
  // minutes later would re-query and re-send borderline teams.
  tries: 1,
  timeout: 300,

  async handle() {
    const now = new Date()
    const appName = config.app?.name || 'UptimeStatus'

    let teams: any[]
    try {
      teams = await Team.where('report_frequency', '!=', 'none').get()
    }
    catch (error) {
      // Most likely the report-settings columns are missing (migration
      // 0000000195 not applied yet; migrations are manual in this repo).
      log.warn(`[job] SendUptimeReports: could not load report settings: ${error}`)
      return
    }

    let sent = 0

    for (const team of teams) {
      // One team's bad data or mail failure must not abort the rest.
      try {
        const frequency = String(team.report_frequency || 'none')
        if (frequency !== 'weekly' && frequency !== 'monthly') continue
        if (!isDue(frequency, team.report_last_sent_at || null, now)) continue

        const { start, end } = reportWindow(frequency, now)
        const startIso = new Date(start).toISOString()
        const endIso = new Date(end).toISOString()
        // The window immediately before the reporting window, same
        // length, used only for the p95 trend comparison.
        const prevStartIso = new Date(start - (end - start)).toISOString()
        const label = periodLabel(frequency, start, end)

        const monitors = await Monitor.where('team_id', team.id).get()

        const monitorReports: MonitorReport[] = []
        let incidentCount = 0
        let incidentDurationMs = 0
        let crawlsCompleted = 0
        let brokenLinks = 0
        let mixedContent = 0

        for (const monitor of monitors) {
          const results = await CheckResult.where('monitor_id', monitor.id)
            .whereBetween('checked_at', [startIso, endIso])
            .get()

          // The check_results status CHECK only allows up/down/degraded,
          // but filter defensively so anything else never skews the
          // denominator. Uptime is up / total known-status checks;
          // degraded counts against uptime.
          const known = results.filter((r: any) => r.status === 'up' || r.status === 'down' || r.status === 'degraded')
          const upCount = known.filter((r: any) => r.status === 'up').length
          const times = results
            .map((r: any) => r.response_time_ms)
            .filter((t: any): t is number => typeof t === 'number')
            .sort((a: number, b: number) => a - b)

          const previous = await CheckResult.where('monitor_id', monitor.id)
            .whereBetween('checked_at', [prevStartIso, startIso])
            .get()
          const prevTimes = previous
            .map((r: any) => r.response_time_ms)
            .filter((t: any): t is number => typeof t === 'number')
            .sort((a: number, b: number) => a - b)

          const p95 = times.length > 0 ? percentile(times, 95) : null
          const prevP95 = prevTimes.length > 0 ? percentile(prevTimes, 95) : null

          let trend: Trend = 'n/a'
          if (p95 !== null && prevP95 !== null && prevP95 > 0) {
            const change = (p95 - prevP95) / prevP95
            if (change > TREND_THRESHOLD) trend = 'degraded'
            else if (change < -TREND_THRESHOLD) trend = 'improved'
            else trend = 'steady'
          }

          monitorReports.push({
            name: monitor.name || `Monitor #${monitor.id}`,
            url: monitor.url || '',
            checkCount: known.length,
            upCount,
            uptimePct: known.length > 0 ? (upCount / known.length) * 100 : null,
            avgMs: times.length > 0 ? times.reduce((sum: number, t: number) => sum + t, 0) / times.length : null,
            p95Ms: p95,
            trend,
          })

          const incidents = await Incident.where('monitor_id', monitor.id)
            .whereBetween('started_at', [startIso, endIso])
            .get()
          for (const incident of incidents) {
            incidentCount++
            const startedMs = Date.parse(incident.started_at)
            if (!Number.isFinite(startedMs)) continue
            // incidents.resolved_at is the real resolution timestamp on
            // this schema (see app/Models/Incident.ts). Resolved incidents
            // missing it fall back to updated_at; unresolved incidents
            // contribute duration up to the window end.
            let endedMs: number
            if (incident.resolved_at && Number.isFinite(Date.parse(incident.resolved_at)))
              endedMs = Date.parse(incident.resolved_at)
            else if (incident.status === 'resolved' && incident.updated_at && Number.isFinite(Date.parse(incident.updated_at)))
              endedMs = Date.parse(incident.updated_at)
            else
              endedMs = end
            endedMs = Math.min(endedMs, end)
            if (endedMs > startedMs) incidentDurationMs += endedMs - startedMs
          }

          const crawls = await Crawl.where('monitor_id', monitor.id)
            .where('status', 'completed')
            .whereBetween('finished_at', [startIso, endIso])
            .get()
          crawlsCompleted += crawls.length
          for (const crawl of crawls) {
            brokenLinks += Number(crawl.broken_links_count) || 0
            mixedContent += Number(crawl.mixed_content_count) || 0
          }
        }

        // Recipients: the comma-separated report_recipients list, or the
        // team owner's email (teams.owner, set at registration) when empty.
        const recipients = String(team.report_recipients || '')
          .split(',')
          .map((entry: string) => entry.trim())
          .filter((entry: string) => entry.includes('@'))
        if (recipients.length === 0 && team.owner && String(team.owner).includes('@'))
          recipients.push(String(team.owner))

        if (recipients.length === 0) {
          log.warn(`[job] SendUptimeReports: team ${team.id} has no recipients and no owner email, skipping`)
          continue
        }

        const report: TeamReport = {
          teamName: team.name || `Team #${team.id}`,
          label,
          monitors: monitorReports,
          incidentCount,
          incidentDurationMs,
          crawlsCompleted,
          brokenLinks,
          mixedContent,
        }

        const subject = `${appName} report for ${report.teamName}: ${label}`
        const html = buildHtml(report, appName)
        const text = buildText(report, appName)

        // mail.send resolves { success: false } on transport failure
        // instead of throwing (see SendTeamInviteEmail), so check it
        // explicitly; a silent failure would still bump report_last_sent_at
        // and the period's report would be lost.
        let allSent = true
        for (const to of recipients) {
          const result = await mail.send({ to, subject, html, text })
          if (!result.success) {
            allSent = false
            log.warn(`[job] SendUptimeReports: send to ${to} for team ${team.id} failed: ${result.message}`)
          }
        }

        if (!allSent) continue // leave report_last_sent_at untouched so the catch-up branch retries

        // forceUpdate: report_last_sent_at is not in the built-in Team
        // model's fillable allowlist (same caveat as RegisterAction's
        // forceCreate for owner/user_id).
        await Team.forceUpdate(team.id, { report_last_sent_at: now.toISOString() })
        sent++
        log.info(`[job] SendUptimeReports: sent ${frequency} report for team ${team.id} (${report.teamName}) to ${recipients.join(', ')}`)
      }
      catch (error) {
        log.error(`[job] SendUptimeReports: failed for team ${team?.id}: ${error}`)
      }
    }

    if (sent > 0)
      log.debug(`[job] SendUptimeReports: sent ${sent} report(s)`)
  },
})
