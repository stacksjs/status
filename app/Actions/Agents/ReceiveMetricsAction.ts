import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import CheckResult from '../../Models/CheckResult'
import Monitor from '../../Models/Monitor'

function isValidPercent(n: number): boolean {
  return Number.isFinite(n) && n >= 0 && n <= 100
}

function isValidMb(n: number): boolean {
  return Number.isFinite(n) && n >= 0
}

/**
 * Public, unauthenticated endpoint a customer's own monitored server pushes
 * CPU/RAM samples to: POST /agent/{token}/metrics. The token is an
 * unguessable random string (Monitor.metricsToken), not a numeric id — same
 * convention as ReceivePingAction's ping_token. Records a CheckResult so the
 * existing per-monitor chart/history machinery picks it up for free.
 */
export default new Action({
  name: 'ReceiveMetricsAction',
  description: 'Record a pushed CPU/RAM metrics sample for a monitor',

  async handle(request) {
    const token = request.get('token')
    const monitor = await Monitor.where('metrics_token', token).first()

    if (!monitor)
      return response.json({ success: false, message: 'Unknown metrics token' }, { status: 404 })

    const cpuPercent = Number(request.get('cpuPercent'))
    const ramPercent = Number(request.get('ramPercent'))
    const ramUsedMb = Number(request.get('ramUsedMb'))
    const ramTotalMb = Number(request.get('ramTotalMb'))

    if (!isValidPercent(cpuPercent) || !isValidPercent(ramPercent) || !isValidMb(ramUsedMb) || !isValidMb(ramTotalMb)) {
      return response.json(
        { success: false, message: 'cpuPercent/ramPercent must be 0-100, ramUsedMb/ramTotalMb must be >= 0' },
        { status: 422 },
      )
    }

    const checkedAt = new Date().toISOString()

    await CheckResult.create({
      monitor_id: monitor.id,
      status: 'up',
      message: 'Agent metrics received',
      metadata: JSON.stringify({ cpuPercent, ramPercent, ramUsedMb, ramTotalMb }),
      region: 'agent',
      checked_at: checkedAt,
    })

    await monitor.update({ last_checked_at: checkedAt, status: 'up' })

    return { success: true }
  },
})
