import { Action } from '@stacksjs/actions'
import { resolveAuthenticatedTeamId } from '@stacksjs/auth'
import { response } from '@stacksjs/router'
import Assertion from '../../Models/Assertion'
import Monitor from '../../Models/Monitor'

const TARGETS = new Set(['status_code', 'header', 'body', 'response_time'])
const COMPARES = new Set(['eq', 'not_eq', 'gt', 'gte', 'lt', 'lte', 'contains', 'not_contains', 'empty', 'not_empty'])

/**
 * `POST /assertion-forms/monitors/{monitorId}/add` — adds a response assertion
 * to a monitor from the monitor detail page (no-JS dashboard form, same
 * pattern as the notification-channel forms). The monitor must belong to the
 * requester's own team. For a `body` target, `property` is an optional JSON
 * dot-path (e.g. "checks.database.latency_ms"); for `header` it is the header
 * name; it is ignored for status_code/response_time.
 */
export default new Action({
  name: 'DashboardCreateAssertionAction',
  description: 'Add a response assertion to a monitor from a dashboard form',

  async handle(request) {
    const authTeamId = await resolveAuthenticatedTeamId(request)
    if (!authTeamId)
      return response.unauthorized('Authentication required')

    const monitorId = Number(request.get('monitorId'))
    const target = String(request.get('target') ?? '')
    const compare = String(request.get('compare') ?? '')
    const property = String(request.get('property') ?? '').trim()
    const expected = String(request.get('expected') ?? '')

    if (monitorId && TARGETS.has(target) && COMPARES.has(compare)) {
      const monitor = await Monitor.where('id', monitorId).where('team_id', authTeamId).first()
      if (!monitor)
        return response.forbidden('You do not have access to this monitor')

      await Assertion.create({
        monitor_id: monitorId,
        target,
        property: property || null,
        compare,
        expected: expected.slice(0, 1000),
        sort_order: 0,
      })
    }

    return new Response(null, { status: 302, headers: { Location: `/dashboard/monitors/${monitorId}` } })
  },
})
