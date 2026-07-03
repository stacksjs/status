import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import StatusReport from '../../Models/StatusReport'
import StatusReportUpdate from '../../Models/StatusReportUpdate'

/**
 * Overrides the useApi-generated `POST /status-report-updates` (user-defined
 * routes in routes/ take priority over auto-generated ones — same pattern
 * as Actions/Monitors/CreateMonitorAction). The override exists because the
 * generated store handler writes via raw `db.insertInto(...)`, which fires
 * NO model events — so StatusReportUpdate's `observe: ['create']` (the
 * trigger for emailing status page subscribers, see app/Events.ts) never
 * ran on the API path. Creating through the ORM here makes posting an
 * update actually notify subscribers.
 */
export default new Action({
  name: 'CreateStatusReportUpdateAction',
  description: 'Post a status report update, notifying status page subscribers',

  async handle(request) {
    const statusReportId = Number(request.get('status_report_id'))
    const message = String(request.get('message') ?? '').trim()
    const status = String(request.get('status') ?? 'investigating')

    if (!statusReportId)
      return response.json({ error: 'status_report_id is required' }, { status: 422 })
    if (!message)
      return response.json({ error: 'message is required' }, { status: 422 })
    if (!['investigating', 'identified', 'monitoring', 'resolved'].includes(status))
      return response.json({ error: `invalid status '${status}'` }, { status: 422 })

    const report = await StatusReport.find(statusReportId)
    if (!report)
      return response.json({ error: `status report ${statusReportId} not found` }, { status: 404 })

    const update = await StatusReportUpdate.create({
      status_report_id: report.id,
      message,
      status,
      posted_at: request.get('posted_at') || new Date().toISOString(),
    })

    return response.json(update, { status: 201 })
  },
})
