import { Action } from '@stacksjs/actions'
import DeliverWebhook from '../../Jobs/DeliverWebhook'
import Monitor from '../../Models/Monitor'
import WebhookSubscription from '../../Models/WebhookSubscription'

/**
 * Fires on `checkresult:created` (registered in app/Events.ts, via
 * CheckResult's `observe: ['create']` trait) — fans out to every enabled
 * webhook subscription for the check's team. High-volume by design (every
 * check, not just incidents); short-circuits immediately when a team has
 * no subscriptions so this is a no-op for the common case.
 */
export default new Action({
  name: 'DeliverCheckResultWebhooks',
  description: 'Fan out a check result to the team\'s webhook subscriptions',

  async handle(checkResult: { id: number, monitor_id: number, status: string, response_time_ms: number | null, checked_at: string }) {
    const monitor = await Monitor.find(checkResult.monitor_id)
    if (!monitor) return

    const subscriptions = await WebhookSubscription.where('team_id', monitor.team_id).where('enabled', true).get()
    if (subscriptions.length === 0) return

    const data = {
      checkResultId: checkResult.id,
      monitorId: monitor.id,
      monitorName: monitor.name,
      monitorType: monitor.type,
      status: checkResult.status,
      responseTimeMs: checkResult.response_time_ms,
      checkedAt: checkResult.checked_at,
    }

    for (const subscription of subscriptions) {
      await DeliverWebhook.dispatch({
        subscriptionId: subscription.id,
        event: 'check_result.created',
        data,
      })
    }
  },
})
