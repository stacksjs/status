import { defineModel } from '@stacksjs/orm'

/**
 * Pivot: which tags are attached to which monitors — same shape as
 * MonitorNotificationChannel.
 */
export default defineModel({
  name: 'MonitorTagAssignment',
  table: 'monitor_tag_assignments',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useTimestamps: true,
  },

  belongsTo: ['Monitor', 'MonitorTag'],

  attributes: {},
} as const)
