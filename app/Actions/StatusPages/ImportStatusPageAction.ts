import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import { limitReachedMessage, planForTeam } from '../../../config/plans'
import Monitor from '../../Models/Monitor'
import StatusPage from '../../Models/StatusPage'
import StatusPageMonitor from '../../Models/StatusPageMonitor'
import { fetchNormalizedStatusPage } from './ImportProviders'

function slugify(input: string): string {
  return input.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'imported'
}

/**
 * `POST /status-pages/import` — a one-time snapshot migration from an
 * existing Better Stack / Instatus / Statuspage.io status page into our
 * own StatusPage + Monitor models (stacksjs/status#1 Phase 12). Not an
 * ongoing sync: this creates real rows the customer owns and edits going
 * forward, same as if they'd built the page by hand — it just saves
 * re-typing every component name.
 *
 * Imported monitors are created disabled (enabled: false) with the
 * source page's own URL as a placeholder: a competitor's status page
 * component isn't a URL we can poll ourselves (Statuspage.io/Instatus/
 * Better Stack don't expose a per-component check target, only a status
 * snapshot) — the customer re-points each one at a real, checkable URL
 * and enables it once they're ready. Enforces the same status-page plan
 * limit as CreateStatusPageAction; does NOT separately enforce the
 * monitor-count limit per import (a large imported page could exceed it)
 * — flagged here rather than silently allowed to look "enforced."
 */
export default new Action({
  name: 'ImportStatusPageAction',
  description: 'Import an existing status page from a competitor service',

  async handle(request) {
    const teamId = Number(request.get('team_id'))
    const provider = String(request.get('provider') ?? '')
    const sourceUrl = String(request.get('source_url') ?? '')

    if (!teamId)
      return response.json({ error: 'team_id is required' }, { status: 422 })
    if (!['statuspage', 'instatus', 'betterstack'].includes(provider))
      return response.json({ error: `provider must be one of: statuspage, instatus, betterstack` }, { status: 422 })
    if (!sourceUrl)
      return response.json({ error: 'source_url is required' }, { status: 422 })

    const existingCount = (await StatusPage.where('team_id', teamId).get()).length
    const { plan, limits } = await planForTeam(teamId)
    if (existingCount >= limits.statusPages) {
      return response.json(
        { error: limitReachedMessage('status pages', limits.statusPages, plan) },
        { status: 402 },
      )
    }

    let imported
    try {
      imported = await fetchNormalizedStatusPage(provider as 'statuspage' | 'instatus' | 'betterstack', sourceUrl)
    }
    catch (error) {
      return response.json(
        { error: `Failed to fetch source status page: ${error instanceof Error ? error.message : String(error)}` },
        { status: 502 },
      )
    }

    const title = String(request.get('title') ?? imported.title)
    const requestedSlug = request.get('slug')
    const slug = requestedSlug ? slugify(String(requestedSlug)) : slugify(title)

    const statusPage = await StatusPage.create({
      team_id: teamId,
      slug,
      title,
      is_public: true,
    })

    let monitorsCreated = 0
    for (const [index, component] of imported.components.entries()) {
      const monitor = await Monitor.create({
        team_id: teamId,
        name: component.name,
        url: sourceUrl,
        type: 'uptime',
        enabled: false,
        check_interval_seconds: 300,
        status: component.status,
      })

      await StatusPageMonitor.create({
        status_page_id: statusPage.id,
        monitor_id: monitor.id,
        display_name: component.name,
        display_order: index,
      })

      monitorsCreated++
    }

    return response.json({
      statusPage,
      monitorsImported: monitorsCreated,
      note: 'Imported monitors are disabled and point at the source page\'s URL as a placeholder — re-point each at a real, checkable URL and enable it.',
    }, { status: 201 })
  },
})
