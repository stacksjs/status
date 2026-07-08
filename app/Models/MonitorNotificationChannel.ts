import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * Pivot: which notification channels are attached to which monitors. A
 * channel lives at the team level (NotificationChannel.belongsTo Team) so
 * it can be reused across monitors without re-entering the same Slack
 * webhook or PagerDuty routing key for every one.
 */
export default defineModel({
  name: 'MonitorNotificationChannel',
  table: 'monitor_notification_channels',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useTimestamps: true,
  },

  belongsTo: ['Monitor', 'NotificationChannel'],

  attributes: {
    // Which incident severities this attachment fires on: 'down' (hard
    // outages only), 'issue' (soft/degraded events only), or 'both'. Lets one
    // channel page on outages while another only hears about issues. Default
    // 'both' preserves fire-on-everything for attachments made before this
    // column existed. See app/lib/notificationSeverity.ts for the match.
    firesOn: {
      order: 0,
      fillable: true,
      default: 'both',
      validation: {
        rule: schema.enum(['down', 'issue', 'both']),
      },
    },
  },
} as const)
