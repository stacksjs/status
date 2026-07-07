import { Action } from '@stacksjs/actions'
import StatusPage from '../../Models/StatusPage'
import StatusPageMonitor from '../../Models/StatusPageMonitor'
import Incident from '../../Models/Incident'
import Monitor from '../../Models/Monitor'
import { isStatusPageAccessGranted } from './AccessControl'

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Public RSS feed of a status page's incidents: GET /status/{slug}/feed.
 * Returns a raw Response (not the json()/text() helpers) so the
 * Content-Type is exactly application/rss+xml — feed readers are strict
 * about this, unlike browsers.
 */
export default new Action({
  name: 'IncidentFeedAction',
  description: 'RSS feed of incidents for a status page',

  async handle(request) {
    const slug = request.get('slug')
    const statusPage = await StatusPage.where('slug', slug).where('is_public', true).first()

    if (!statusPage) {
      return new Response('Not found', { status: 404 })
    }

    // Access-controlled pages must gate the feed too — `is_public` alone is
    // not the gate. Without this, a password/email/IP-restricted page's entire
    // incident history leaks in machine-readable form at /feed. Return the
    // same 404 as a missing page so the feed doesn't confirm the page exists.
    const accessGranted = await isStatusPageAccessGranted({
      accessType: statusPage.access_type,
      statusPageId: statusPage.id,
      allowedIpRanges: statusPage.allowed_ip_ranges,
      ip: request.ip(),
      unlockCookie: request.cookie(`status_unlock_${slug}`),
    })
    if (!accessGranted) {
      return new Response('Not found', { status: 404 })
    }

    const attachments = await StatusPageMonitor.where('status_page_id', statusPage.id).get()
    const monitorIds = attachments.map(a => a.monitor_id)

    const items: string[] = []
    for (const monitorId of monitorIds) {
      const monitor = await Monitor.find(monitorId)
      if (!monitor) continue
      const incidents = await Incident.where('monitor_id', monitorId).orderByDesc('started_at').limit(20).get()
      for (const incident of incidents) {
        const link = `/status/${statusPage.slug}/incidents/${incident.id}`
        items.push(`
    <item>
      <title>${escapeXml(`${monitor.name}: ${incident.cause || incident.status}`)}</title>
      <link>${escapeXml(link)}</link>
      <guid>${escapeXml(link)}</guid>
      <pubDate>${new Date(incident.started_at).toUTCString()}</pubDate>
      <description>${escapeXml(incident.cause || '')}</description>
    </item>`)
      }
    }

    // Newest first across all monitors, not just per-monitor order.
    items.sort((a, b) => {
      const dateOf = (s: string) => new Date(s.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] ?? 0).getTime()
      return dateOf(b) - dateOf(a)
    })

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeXml(statusPage.title)}</title>
    <link>/status/${escapeXml(statusPage.slug)}</link>
    <description>Incident history for ${escapeXml(statusPage.title)}</description>${items.join('')}
  </channel>
</rss>`

    return new Response(xml, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } })
  },
})
