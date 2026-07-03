import { Action } from '@stacksjs/actions'
import Assertion from '../../Models/Assertion'

export interface AssertionSubject {
  statusCode: number
  headers: Record<string, string>
  body: string
  responseTimeMs: number
}

export interface AssertionEvaluation {
  passed: boolean
  /** Human-readable failure messages, one per failed assertion — empty when passed is true. */
  failures: string[]
}

function actualValue(assertion: { target: string, property: string | null }, subject: AssertionSubject): string | number {
  switch (assertion.target) {
    case 'status_code':
      return subject.statusCode
    case 'response_time':
      return subject.responseTimeMs
    case 'header':
      return subject.headers[(assertion.property || '').toLowerCase()] ?? ''
    case 'body':
      return subject.body
    default:
      return ''
  }
}

function describe(assertion: { target: string, property: string | null, compare: string, expected: string }): string {
  const what = assertion.target === 'header' ? `header "${assertion.property}"` : assertion.target.replace('_', ' ')
  return `${what} ${assertion.compare} "${assertion.expected}"`
}

/**
 * Evaluates a single Assertion against a check's response. Numeric
 * compares (gt/gte/lt/lte) coerce both sides with Number() — an
 * unparseable expected value fails safe (never passes silently).
 */
function evaluateOne(assertion: { target: string, property: string | null, compare: string, expected: string }, subject: AssertionSubject): boolean {
  const actual = actualValue(assertion, subject)

  switch (assertion.compare) {
    case 'empty':
      return actual === '' || actual == null
    case 'not_empty':
      return !(actual === '' || actual == null)
    case 'eq':
      return String(actual) === assertion.expected
    case 'not_eq':
      return String(actual) !== assertion.expected
    case 'contains':
      return String(actual).includes(assertion.expected)
    case 'not_contains':
      return !String(actual).includes(assertion.expected)
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = Number(actual)
      const b = Number(assertion.expected)
      if (Number.isNaN(a) || Number.isNaN(b)) return false
      if (assertion.compare === 'gt') return a > b
      if (assertion.compare === 'gte') return a >= b
      if (assertion.compare === 'lt') return a < b
      return a <= b
    }
    default:
      return false
  }
}

/**
 * Evaluates every Assertion attached to a monitor against one check's
 * response (stacksjs/status#1 Phase 12). Called by RunUptimeCheck/
 * RunHealthCheck after a successful HTTP response — a monitor with zero
 * assertions always passes (the existing plain up/down-by-status-code
 * behavior is unaffected). ALL assertions must pass for `passed: true`.
 */
export default new Action({
  name: 'EvaluateAssertionsAction',
  description: 'Evaluate a monitor\'s assertions against a check response',

  async handle(payload: { monitorId: number, subject: AssertionSubject }): Promise<AssertionEvaluation> {
    const assertions = await Assertion.where('monitor_id', payload.monitorId).orderBy('sort_order', 'asc').get()
    if (assertions.length === 0)
      return { passed: true, failures: [] }

    const failures: string[] = []
    for (const assertion of assertions) {
      if (!evaluateOne(assertion, payload.subject))
        failures.push(`Assertion failed: ${describe(assertion)}`)
    }

    return { passed: failures.length === 0, failures }
  },
})
