import { parseCron } from '@stacksjs/cron'

/**
 * Whether a cron expression parses: 5-field expressions, @daily-style
 * nicknames, and range/step/named-value syntax (via @stacksjs/cron). Shared by
 * the heartbeat cadence and maintenance-recurrence model validators and the
 * runtime deadline math, so "valid" means the same thing at create time and at
 * evaluation time.
 */
export function isValidCron(expression: string): boolean {
  try {
    return parseCron(expression, 0) !== null
  }
  catch {
    return false
  }
}
