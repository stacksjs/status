import { Action } from '@stacksjs/actions'
import { log } from '@stacksjs/logging'
import AiCheck from '../../Models/AiCheck'
import Monitor from '../../Models/Monitor'
import RunAiCheck from '../../Jobs/RunAiCheck'
import RunBlocklistCheck from '../../Jobs/RunBlocklistCheck'
import RunCrawl from '../../Jobs/RunCrawl'
import RunDnsCheck from '../../Jobs/RunDnsCheck'
import RunDomainCheck from '../../Jobs/RunDomainCheck'
import RunHealthCheck from '../../Jobs/RunHealthCheck'
import RunLighthouseAudit from '../../Jobs/RunLighthouseAudit'
import RunPingCheck from '../../Jobs/RunPingCheck'
import RunPortScan from '../../Jobs/RunPortScan'
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
  port_scan: RunPortScan,
  dns_blocklist: RunBlocklistCheck,
}

/**
 * Triggers an immediate, on-demand check for a single monitor (the
 * `POST /monitors/:id/check` route), independent of the scheduler's
 * every-minute cadence. 'cron' monitors are heartbeat-based and have
 * nothing to actively check. 'ai_check' fans out one RunAiCheck per
 * attached AiCheck assertion, same as DispatchDueChecks.
 */
export default new Action({
  name: 'RunCheckAction',
  description: 'Run an on-demand check for a monitor',

  async handle(request) {
    const id = request.get('id')
    const monitor = await Monitor.find(Number(id))

    if (!monitor)
      return { success: false, message: `Monitor ${id} not found` }

    if (monitor.type === 'ai_check') {
      const assertions = await AiCheck.where('monitor_id', monitor.id).get()
      if (assertions.length === 0)
        return { success: false, message: `Monitor ${monitor.name} has no AI check assertions configured` }
      for (const assertion of assertions)
        await RunAiCheck.dispatch({ monitorId: monitor.id, aiCheckId: assertion.id })
      return { success: true, message: `${assertions.length} AI check(s) dispatched for ${monitor.name}` }
    }

    const job = CHECK_JOBS[monitor.type]
    if (!job) {
      log.warn(`[RunCheckAction] Monitor type '${monitor.type}' has no on-demand check runner yet`)
      return { success: false, message: `Check type '${monitor.type}' is not implemented yet` }
    }

    await job.dispatch({ monitorId: monitor.id })
    return { success: true, message: `Check dispatched for ${monitor.name}` }
  },
})
