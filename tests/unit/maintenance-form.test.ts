import { describe, expect, test } from 'bun:test'
import {
  isMaintenanceStatus,
  MAINTENANCE_STATUSES,
  parseLocalDateTime,
  parseMaintenanceForm,
  toDateTimeLocalValue,
} from '../../app/lib/maintenanceForm'

describe('parseLocalDateTime', () => {
  test('reads a datetime-local value as UTC, not as the server box\'s zone', () => {
    // The whole point: `new Date('2026-08-25T14:30')` is LOCAL time, so on a
    // non-UTC host this would silently shift the window by the offset.
    expect(parseLocalDateTime('2026-08-25T14:30')).toBe('2026-08-25T14:30:00.000Z')
  })

  test('keeps an already-zoned value as given, so an edit round-trips', () => {
    expect(parseLocalDateTime('2026-08-25T14:30:00.000Z')).toBe('2026-08-25T14:30:00.000Z')
    expect(parseLocalDateTime('2026-08-25T14:30:00+02:00')).toBe('2026-08-25T12:30:00.000Z')
  })

  test('rejects blanks and nonsense rather than inventing a date', () => {
    for (const bad of ['', '   ', 'tomorrow', 'not-a-date', null, undefined, {}])
      expect(parseLocalDateTime(bad)).toBeNull()
  })
})

describe('toDateTimeLocalValue', () => {
  test('renders an ISO timestamp back into the input format', () => {
    expect(toDateTimeLocalValue('2026-08-25T14:30:00.000Z')).toBe('2026-08-25T14:30')
  })

  test('an unparseable stored value yields an empty input, not "Invalid Date"', () => {
    expect(toDateTimeLocalValue('garbage')).toBe('')
    expect(toDateTimeLocalValue(null)).toBe('')
  })

  test('round-trips with parseLocalDateTime', () => {
    const iso = '2026-12-01T03:05:00.000Z'
    expect(parseLocalDateTime(toDateTimeLocalValue(iso))).toBe(iso)
  })
})

describe('isMaintenanceStatus', () => {
  test('accepts exactly the four model statuses', () => {
    for (const s of MAINTENANCE_STATUSES) expect(isMaintenanceStatus(s)).toBe(true)
    for (const s of ['open', 'resolved', '', 'Scheduled', null, 3]) expect(isMaintenanceStatus(s)).toBe(false)
  })
})

describe('parseMaintenanceForm', () => {
  const valid = {
    title: 'Database upgrade',
    description: 'Moving to the new primary.',
    starts_at: '2026-09-01T02:00',
    ends_at: '2026-09-01T04:00',
  }

  test('accepts a well-formed one-off window', () => {
    const result = parseMaintenanceForm(valid)
    expect(result.ok).toBe(true)
    expect(result.values.title).toBe('Database upgrade')
    expect(result.values.starts_at).toBe('2026-09-01T02:00:00.000Z')
    expect(result.values.ends_at).toBe('2026-09-01T04:00:00.000Z')
    expect(result.values.recurrence_cron).toBeNull()
    expect(result.values.status).toBe('scheduled')
  })

  test('a title is required and is trimmed', () => {
    expect(parseMaintenanceForm({ ...valid, title: '   ' }).error).toBe('title_required')
    expect(parseMaintenanceForm({ ...valid, title: '  Padded  ' }).values.title).toBe('Padded')
  })

  test('rejects an over-long title or description at the model\'s own limits', () => {
    expect(parseMaintenanceForm({ ...valid, title: 'x'.repeat(151) }).error).toBe('title_too_long')
    expect(parseMaintenanceForm({ ...valid, description: 'x'.repeat(2001) }).error).toBe('description_too_long')
    expect(parseMaintenanceForm({ ...valid, title: 'x'.repeat(150) }).ok).toBe(true)
  })

  test('an empty description is stored as null, not an empty string', () => {
    expect(parseMaintenanceForm({ ...valid, description: '' }).values.description).toBeNull()
    expect(parseMaintenanceForm({ title: 'T', starts_at: valid.starts_at, ends_at: valid.ends_at }).values.description).toBeNull()
  })

  test('both timestamps are required and must parse', () => {
    expect(parseMaintenanceForm({ ...valid, starts_at: '' }).error).toBe('starts_at_invalid')
    expect(parseMaintenanceForm({ ...valid, ends_at: 'soon' }).error).toBe('ends_at_invalid')
  })

  /**
   * The duration of the anchor window is what every recurrence occurrence
   * inherits (expandWindowIntervals uses ends_at - starts_at), so a
   * backwards or zero-length anchor would not just be one bad window — it
   * would suppress nothing on every future occurrence while still
   * announcing each one to subscribers.
   */
  test('the window must end after it starts', () => {
    expect(parseMaintenanceForm({ ...valid, ends_at: '2026-09-01T01:00' }).error).toBe('ends_before_starts')
    expect(parseMaintenanceForm({ ...valid, ends_at: valid.starts_at }).error).toBe('ends_before_starts')
  })

  test('a recurrence expression is optional but must be valid when given', () => {
    expect(parseMaintenanceForm({ ...valid, recurrence_cron: '' }).values.recurrence_cron).toBeNull()
    expect(parseMaintenanceForm({ ...valid, recurrence_cron: '0 2 * * 0' }).values.recurrence_cron).toBe('0 2 * * 0')
    expect(parseMaintenanceForm({ ...valid, recurrence_cron: '@weekly' }).ok).toBe(true)
    expect(parseMaintenanceForm({ ...valid, recurrence_cron: 'every sunday' }).error).toBe('cron_invalid')
  })

  test('status defaults to scheduled and rejects anything off the model enum', () => {
    expect(parseMaintenanceForm(valid).values.status).toBe('scheduled')
    expect(parseMaintenanceForm({ ...valid, status: 'cancelled' }).values.status).toBe('cancelled')
    expect(parseMaintenanceForm({ ...valid, status: 'resolved' }).error).toBe('status_invalid')
  })

  test('a failed parse never leaks half-parsed values a caller might persist', () => {
    const result = parseMaintenanceForm({ ...valid, ends_at: '2026-01-01T00:00' })
    expect(result.ok).toBe(false)
    expect(result.values.title).toBe('')
    expect(result.values.starts_at).toBe('')
  })
})
