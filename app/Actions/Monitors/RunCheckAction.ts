import { Action } from '@stacksjs/actions'
import { log } from '@stacksjs/logging'
import Monitor from '../../Models/Monitor'
import RunUptimeCheck from '../../Jobs/RunUptimeCheck'

/**
 * Triggers an immediate, on-demand check for a single monitor (the
 * `POST /monitors/:id/check` route), independent of the scheduler's
 * every-minute cadence. Only `uptime` is implemented so far (Phase 2 of
 * stacksjs/status#1 adds ssl, dns, ping, tcp_port, domain, health, cron).
 */
export default new Action({
  name: 'RunCheckAction',
  description: 'Run an on-demand check for a monitor',

  async handle(request) {
    const id = request.get('id')
    const monitor = await Monitor.find(Number(id))

    if (!monitor)
      return { success: false, message: `Monitor ${id} not found` }

    switch (monitor.type) {
      case 'uptime':
        await RunUptimeCheck.dispatch({ monitorId: monitor.id })
        return { success: true, message: `Uptime check dispatched for ${monitor.name}` }
      default:
        log.warn(`[RunCheckAction] Monitor type '${monitor.type}' has no check runner yet`)
        return { success: false, message: `Check type '${monitor.type}' is not implemented yet` }
    }
  },
})
