import { defineModel } from '@stacksjs/orm'

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

  attributes: {},
} as const)
