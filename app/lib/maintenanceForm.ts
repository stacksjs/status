import { isValidCron } from './cron'

/**
 * Parsing and validation for the maintenance-window dashboard forms, kept
 * out of the actions for the same reason monitorForm.ts is: the rules are
 * worth testing without standing up HTTP, and the create and update forms
 * must agree about them. The actions own auth and persistence; this owns
 * "is this a coherent window".
 *
 * See docs/operate/maintenance.md for what a window means operationally —
 * during one, a failing check must not open an incident or page anyone,
 * and the time is excluded from uptime.
 */

export const MAINTENANCE_STATUSES = ['scheduled', 'active', 'completed', 'cancelled'] as const
export type MaintenanceStatus = typeof MAINTENANCE_STATUSES[number]

export function isMaintenanceStatus(value: unknown): value is MaintenanceStatus {
  return typeof value === 'string' && (MAINTENANCE_STATUSES as readonly string[]).includes(value)
}

/**
 * `<input type="datetime-local">` posts `YYYY-MM-DDTHH:mm` with no zone,
 * and `new Date()` would read that as the *server's* local time — which on
 * a UTC box is right by accident and wrong everywhere else. The form
 * labels these fields UTC and this is where that promise is kept: the
 * value is pinned to UTC explicitly rather than inheriting whatever zone
 * the process happens to run in.
 *
 * Also accepts a full ISO string so a window round-trips through the edit
 * form unchanged.
 */
export function parseLocalDateTime(raw: unknown): string | null {
  const value = String(raw ?? '').trim()
  if (!value)
    return null

  // Already zoned (ends in Z or ±HH:MM) — trust it.
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value)
  const candidate = zoned ? value : `${value}Z`
  const ms = Date.parse(candidate)
  if (!Number.isFinite(ms))
    return null

  return new Date(ms).toISOString()
}

/** ISO -> the `YYYY-MM-DDTHH:mm` a datetime-local input expects. */
export function toDateTimeLocalValue(iso: unknown): string {
  const ms = Date.parse(String(iso ?? ''))
  if (!Number.isFinite(ms))
    return ''
  return new Date(ms).toISOString().slice(0, 16)
}

export interface MaintenanceFormInput {
  title?: unknown
  description?: unknown
  starts_at?: unknown
  ends_at?: unknown
  recurrence_cron?: unknown
  status?: unknown
}

export interface MaintenanceFormResult {
  ok: boolean
  /** Stable code the view turns into a sentence, matching the monitor form's convention. */
  error?: string
  values: {
    title: string
    description: string | null
    starts_at: string
    ends_at: string
    recurrence_cron: string | null
    status: MaintenanceStatus
  }
}

const EMPTY: MaintenanceFormResult['values'] = {
  title: '',
  description: null,
  starts_at: '',
  ends_at: '',
  recurrence_cron: null,
  status: 'scheduled',
}

function fail(error: string): MaintenanceFormResult {
  return { ok: false, error, values: EMPTY }
}

export function parseMaintenanceForm(input: MaintenanceFormInput): MaintenanceFormResult {
  const title = String(input.title ?? '').trim()
  if (!title)
    return fail('title_required')
  if (title.length > 150)
    return fail('title_too_long')

  const description = String(input.description ?? '').trim()
  if (description.length > 2000)
    return fail('description_too_long')

  const startsAt = parseLocalDateTime(input.starts_at)
  if (!startsAt)
    return fail('starts_at_invalid')

  const endsAt = parseLocalDateTime(input.ends_at)
  if (!endsAt)
    return fail('ends_at_invalid')

  // A zero-length window is almost certainly a mis-fill rather than an
  // intent, and it would suppress nothing while still announcing itself to
  // subscribers. The duration is also what every recurrence occurrence
  // inherits (expandWindowIntervals uses ends_at - starts_at), so a
  // backwards anchor would poison every future occurrence too.
  if (Date.parse(endsAt) <= Date.parse(startsAt))
    return fail('ends_before_starts')

  const cronRaw = String(input.recurrence_cron ?? '').trim()
  if (cronRaw && !isValidCron(cronRaw))
    return fail('cron_invalid')

  const status = input.status === undefined || input.status === null || input.status === ''
    ? 'scheduled'
    : input.status
  if (!isMaintenanceStatus(status))
    return fail('status_invalid')

  return {
    ok: true,
    values: {
      title,
      description: description || null,
      starts_at: startsAt,
      ends_at: endsAt,
      recurrence_cron: cronRaw || null,
      status,
    },
  }
}
