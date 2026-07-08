import process from 'node:process'
import { log } from '@stacksjs/logging'
import { Job } from '@stacksjs/queue'
import CheckResult from '../Models/CheckResult'
import Crawl from '../Models/Crawl'
import CrawledPage from '../Models/CrawledPage'
import Incident from '../Models/Incident'
import Monitor from '../Models/Monitor'
import { broadcastMonitorUpdate } from '../Realtime/broadcastMonitorUpdate'

const MAX_PAGES = 200
const FETCH_TIMEOUT_MS = 15_000

interface ExtractedLinks {
  links: string[]
  resources: string[]
}

/**
 * Extracts same-page `<a href>` targets (crawl frontier) and
 * `<img src>`/`<script src>`/`<link href>` resource URLs (mixed-content
 * check) using Bun's native HTMLRewriter — no HTML parsing dependency
 * needed.
 */
function extractLinks(html: string, baseUrl: string): ExtractedLinks {
  const links: string[] = []
  const resources: string[] = []

  const resolve = (raw: string | null): string | null => {
    if (!raw) return null
    try {
      return new URL(raw, baseUrl).toString()
    }
    catch {
      return null
    }
  }

  new HTMLRewriter()
    .on('a[href]', {
      element(el) {
        const resolved = resolve(el.getAttribute('href'))
        if (resolved) links.push(resolved)
      },
    })
    .on('img[src]', {
      element(el) {
        const resolved = resolve(el.getAttribute('src'))
        if (resolved) resources.push(resolved)
      },
    })
    .on('script[src]', {
      element(el) {
        const resolved = resolve(el.getAttribute('src'))
        if (resolved) resources.push(resolved)
      },
    })
    .on('link[href]', {
      element(el) {
        const resolved = resolve(el.getAttribute('href'))
        if (resolved) resources.push(resolved)
      },
    })
    .transform(new Response(html))

  return { links, resources }
}

/**
 * Fetches robots.txt (if present) and returns Disallow paths for the '*'
 * user-agent group. Best-effort — a missing/unparseable robots.txt means
 * "nothing disallowed", not a crawl failure.
 */
async function fetchDisallowedPaths(origin: string): Promise<string[]> {
  try {
    const response = await fetch(new URL('/robots.txt', origin).toString(), {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) return []

    const text = await response.text()
    const disallowed: string[] = []
    let inWildcardGroup = false

    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (/^user-agent:\s*\*/i.test(trimmed)) {
        inWildcardGroup = true
        continue
      }
      if (/^user-agent:/i.test(trimmed)) {
        inWildcardGroup = false
        continue
      }
      const match = inWildcardGroup && trimmed.match(/^disallow:\s*(\S+)/i)
      if (match) disallowed.push(match[1]!)
    }
    return disallowed
  }
  catch {
    return []
  }
}

function isDisallowed(path: string, disallowedPaths: string[]): boolean {
  return disallowedPaths.some(prefix => prefix !== '' && path.startsWith(prefix))
}

/**
 * BFS crawl of a monitor's site: same-origin pages only, respects
 * robots.txt, records every page + link with its status code, and flags
 * `http://` resources loaded from an `https://` page as mixed content.
 * Runs on a much longer interval than the lightweight checks (see
 * DispatchDueChecks) — a full-site crawl is comparatively expensive.
 */
export default new Job({
  name: 'RunCrawl',
  description: 'Crawl a monitor\'s site for broken links and mixed content',
  queue: 'crawls',
  tries: 1,
  timeout: 300,

  async handle(payload: { monitorId: number }) {
    const monitor = await Monitor.find(payload.monitorId)
    if (!monitor) {
      log.warn(`[job] RunCrawl: monitor ${payload.monitorId} not found`)
      return
    }

    const startedAtMs = performance.now()

    let origin: string
    try {
      origin = new URL(monitor.url).origin
    }
    catch (error) {
      log.warn(`[job] RunCrawl: invalid URL for ${monitor.name}: ${error instanceof Error ? error.message : String(error)}`)
      // The crawl never started so there is no verdict, but last_checked_at
      // must still advance - DispatchDueChecks schedules off it, so returning
      // without it would re-dispatch this (expensive, typically daily) crawl
      // every minute. No CheckResult row: check_results.status is constrained
      // to up/down/degraded and none of those fits "could not run", so the
      // monitor keeps its current status.
      await monitor.update({ last_checked_at: new Date().toISOString() })
      // Push this check outcome to the live-status broadcaster so the
      // dashboard updates sub-second. Fire-and-forget; a no-op unless
      // Redis fan-out is enabled (the poller is the fallback).
      void broadcastMonitorUpdate(monitor.id)
      return
    }

    const disallowedPaths = await fetchDisallowedPaths(origin)

    // The broken-link count from the last completed crawl, so we alert only
    // when the count RISES rather than re-opening an incident every crawl for
    // the same known backlog. Filter to 'completed' so this can't pick up the
    // 'running' row we create just below, nor a failed crawl whose count is
    // the default 0. Read as snake_case off the hydrated model.
    const previousCrawl = await Crawl.where('monitor_id', monitor.id)
      .where('status', 'completed')
      .orderByDesc('created_at')
      .first()
    const previousBrokenLinks = Number(previousCrawl?.broken_links_count) || 0

    const startedAt = new Date().toISOString()
    const crawl = await Crawl.create({
      monitor_id: monitor.id,
      started_at: startedAt,
      status: 'running',
    })

    const visited = new Set<string>()
    const queue: Array<{ url: string, foundOnUrl: string }> = [{ url: monitor.url, foundOnUrl: monitor.url }]
    let brokenLinksCount = 0
    let mixedContentCount = 0
    let pagesCrawled = 0

    while (queue.length > 0 && visited.size < MAX_PAGES) {
      const { url, foundOnUrl } = queue.shift()!
      if (visited.has(url)) continue
      visited.add(url)

      let statusCode = 0
      let html = ''
      let isBrokenLink = false

      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
        statusCode = response.status
        isBrokenLink = response.status >= 400
        if (!isBrokenLink && response.headers.get('content-type')?.includes('text/html'))
          html = await response.text()
      }
      catch {
        statusCode = 0
        isBrokenLink = true
      }

      if (isBrokenLink) brokenLinksCount++

      await CrawledPage.create({
        crawl_id: crawl.id,
        url,
        status_code: statusCode,
        found_on_url: foundOnUrl,
        is_mixed_content: false,
        is_broken_link: isBrokenLink,
      })
      pagesCrawled++

      if (!html) continue

      const { links, resources } = extractLinks(html, url)

      const pageIsHttps = url.startsWith('https://')
      const mixedContentResources = pageIsHttps ? resources.filter(r => r.startsWith('http://')) : []
      if (mixedContentResources.length > 0) {
        mixedContentCount += mixedContentResources.length
        for (const resource of mixedContentResources) {
          await CrawledPage.create({
            crawl_id: crawl.id,
            url: resource,
            status_code: 0,
            found_on_url: url,
            is_mixed_content: true,
            is_broken_link: false,
          })
        }
      }

      for (const link of links) {
        let linkUrl: URL
        try {
          linkUrl = new URL(link)
        }
        catch {
          continue
        }
        if (linkUrl.origin !== origin) continue // same-origin only
        if (visited.has(link)) continue
        if (isDisallowed(linkUrl.pathname, disallowedPaths)) continue
        queue.push({ url: link, foundOnUrl: url })
      }
    }

    // Sitemap monitoring: cross-check sitemap.xml URLs against what the
    // crawl actually found. A URL present in the sitemap but never reached
    // by following links (isolated/orphaned) or that itself 404s is worth
    // flagging — a page can be de-facto broken even if nothing links to it
    // anymore, because search engines still crawl the sitemap directly.
    const sitemapIssues = await checkSitemap(origin, visited, crawl.id)
    if (sitemapIssues > 0)
      brokenLinksCount += sitemapIssues

    await crawl.update({
      finished_at: new Date().toISOString(),
      pages_crawled: pagesCrawled,
      broken_links_count: brokenLinksCount,
      mixed_content_count: mixedContentCount,
      status: 'completed',
    })

    log.info(`[job] RunCrawl: ${monitor.name} — ${pagesCrawled} page(s), ${brokenLinksCount} broken link(s), ${mixedContentCount} mixed-content resource(s)`)

    // Opens only when the broken-link count RISES vs the last completed crawl
    // (drives notification dispatch via Incident's observe trait). Gating on a
    // rise, not the absolute count, means a steady known backlog (5 -> 5) stays
    // quiet while a regression (5 -> 8, or a first crawl 0 -> N) alerts. A
    // missing baseline counts as 0, so the first crawl that finds broken links
    // still reports them. Previously this fired on every crawl that found any
    // broken link, re-alerting the same backlog daily (stacksjs/status#1).
    if (brokenLinksCount > previousBrokenLinks) {
      await Incident.create({
        monitor_id: monitor.id,
        started_at: new Date().toISOString(),
        cause: `Crawl of ${monitor.name} found ${brokenLinksCount} broken link${brokenLinksCount === 1 ? '' : 's'} (up from ${previousBrokenLinks})`,
        status: 'investigating',
        impacted_checks: JSON.stringify([{ type: 'broken_links', brokenLinksCount, previousBrokenLinks }]),
      })
    }

    if (mixedContentCount > 0) {
      await Incident.create({
        monitor_id: monitor.id,
        started_at: new Date().toISOString(),
        cause: `Crawl of ${monitor.name} found ${mixedContentCount} mixed-content resource${mixedContentCount === 1 ? '' : 's'}`,
        status: 'investigating',
        impacted_checks: JSON.stringify([{ type: 'mixed_content', mixedContentCount }]),
      })
    }

    // Findings mean the site is reachable but has issues, so they map to
    // 'degraded' rather than 'down' (matching the incidents above).
    const checkedAt = new Date().toISOString()
    const status: 'up' | 'degraded' = brokenLinksCount > 0 || mixedContentCount > 0 ? 'degraded' : 'up'
    const message = status === 'up'
      ? `Crawled ${pagesCrawled} page(s), no broken links or mixed content`
      : `Crawled ${pagesCrawled} page(s): ${brokenLinksCount} broken link(s), ${mixedContentCount} mixed-content resource(s)`

    await CheckResult.create({
      monitor_id: monitor.id,
      status,
      response_time_ms: Math.round(performance.now() - startedAtMs),
      status_code: 0,
      message,
      metadata: JSON.stringify({ pagesCrawled, brokenLinksCount, mixedContentCount }),
      region: process.env.WORKER_REGION || 'default',
      checked_at: checkedAt,
    })

    // last_checked_at must advance on every terminal path - DispatchDueChecks
    // schedules off it, so skipping it would re-dispatch this check every minute.
    const consecutiveFailures = status === 'up' ? 0 : monitor.consecutive_failures + 1
    await monitor.update({ status, last_checked_at: checkedAt, consecutive_failures: consecutiveFailures })
    void broadcastMonitorUpdate(monitor.id)
  },
})

/**
 * Fetches sitemap.xml (if present), checks every listed URL not already
 * crawled, and records any that 404 or otherwise fail. Returns the count of
 * new issues found so the caller can fold it into the crawl's broken-link
 * total. Best-effort — a missing/unparseable sitemap is not a crawl failure.
 */
async function checkSitemap(origin: string, visited: Set<string>, crawlId: number): Promise<number> {
  let xml: string
  try {
    const response = await fetch(new URL('/sitemap.xml', origin).toString(), {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) return 0
    xml = await response.text()
  }
  catch {
    return 0
  }

  const urls = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m => m[1]!)
  let issues = 0

  for (const url of urls) {
    if (visited.has(url)) continue // already checked during the crawl itself

    let statusCode = 0
    let ok = false
    try {
      const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
      statusCode = response.status
      ok = response.ok
    }
    catch {
      statusCode = 0
    }

    if (!ok) {
      issues++
      await CrawledPage.create({
        crawl_id: crawlId,
        url,
        status_code: statusCode,
        found_on_url: 'sitemap.xml',
        is_mixed_content: false,
        is_broken_link: true,
      })
    }
  }

  return issues
}
