import { defineModel } from '@stacksjs/orm'

/**
 * Pivot: which monitors a maintenance window covers. A status page only
 * shows a maintenance banner when one of ITS monitors is in the window —
 * same "curated" relationship shape as StatusPageMonitor.
 */
export default defineModel({
  name: 'MaintenanceWindowMonitor',
  table: 'maintenance_window_monitors',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useTimestamps: true,
  },

  belongsTo: ['MaintenanceWindow', 'Monitor'],

  attributes: {},
} as const)
