import { defineModel } from '@stacksjs/orm'

/**
 * Pivot: which monitors a StatusReport is about — same shape as
 * MaintenanceWindowMonitor. A status page shows a report when one of
 * ITS monitors is covered by it.
 */
export default defineModel({
  name: 'StatusReportMonitor',
  table: 'status_report_monitors',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useTimestamps: true,
  },

  belongsTo: ['StatusReport', 'Monitor'],

  attributes: {},
} as const)
