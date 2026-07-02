import { Action } from '@stacksjs/actions'
import { log } from '@stacksjs/logging'
import Monitor from '../../Models/Monitor'
import RunCrawl from '../../Jobs/RunCrawl'
import RunDnsCheck from '../../Jobs/RunDnsCheck'
import RunDomainCheck from '../../Jobs/RunDomainCheck'
import RunHealthCheck from '../../Jobs/RunHealthCheck'
import RunLighthouseAudit from '../../Jobs/RunLighthouseAudit'
import RunPingCheck from '../../Jobs/RunPingCheck'
import RunSslCheck from '../../Jobs/RunSslCheck'
import RunTcpPortCheck from '../../Jobs/RunTcpPortCheck'
import RunUptimeCheck from '../../Jobs/RunUptimeCheck'

const CHECK_JOBS: Partial<Record<string, { dispatch: (payload: { monitorId: number }) => Promise<unknown> }>> = {
  uptime: RunUptimeCheck,
  performance: RunUptimeCheck,
  ssl: RunSslCheck,
  ping: RunPingCheck,
  tcp_port: RunTcpPortCheck,
  dns: RunDnsCheck,
  domain: RunDomainCheck,
  health: RunHealthCheck,
  broken_links: RunCrawl,
  lighthouse: RunLighthouseAudit,
}

/**
 * Triggers an immediate, on-demand check for a single monitor (the
 * `POST /monitors/:id/check` route), independent of the scheduler's
 * every-minute cadence. 'cron' monitors are heartbeat-based and have
 * nothing to actively check; 'broken_links'/'performance'/'lighthouse'/
 * 'port_scan'/'dns_blocklist'/'ai_check' land in later phases.
 */
export default new Action({
  name: 'RunCheckAction',
  description: 'Run an on-demand check for a monitor',

  async handle(request) {
    const id = request.get('id')
    const monitor = await Monitor.find(Number(id))

    if (!monitor)
      return { success: false, message: `Monitor ${id} not found` }

    const job = CHECK_JOBS[monitor.type]
    if (!job) {
      log.warn(`[RunCheckAction] Monitor type '${monitor.type}' has no on-demand check runner yet`)
      return { success: false, message: `Check type '${monitor.type}' is not implemented yet` }
    }

    await job.dispatch({ monitorId: monitor.id })
    return { success: true, message: `Check dispatched for ${monitor.name}` }
  },
})
