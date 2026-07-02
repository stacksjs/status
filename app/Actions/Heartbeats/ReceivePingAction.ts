import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import HeartbeatMonitor from '../../Models/HeartbeatMonitor'

/**
 * Public, unauthenticated endpoint the customer's cron job / scheduled task
 * pings on every successful run: GET or POST /ping/{token}. The token is an
 * unguessable random string (HeartbeatMonitor.pingToken), not a numeric id,
 * so there's nothing to enumerate or authenticate — matching Oh Dear /
 * Healthchecks.io convention (`curl https://.../ping/<uuid>` as the last
 * line of a cron job).
 */
export default new Action({
  name: 'ReceivePingAction',
  description: 'Record a heartbeat ping for a scheduled-task monitor',

  async handle(request) {
    const token = request.get('token')
    const heartbeat = await HeartbeatMonitor.where('ping_token', token).first()

    if (!heartbeat)
      return response.json({ success: false, message: 'Unknown ping token' }, { status: 404 })

    await heartbeat.update({ last_ping_at: new Date().toISOString() })

    return { success: true }
  },
})
