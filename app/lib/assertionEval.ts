/**
 * Pure evaluation for a monitor's response Assertions (stacksjs/status#1),
 * extracted so it can be unit-tested without a DB or a live check. Used by
 * EvaluateAssertionsAction, which loads a monitor's Assertion rows and runs
 * each one against a check's response.
 *
 * Targets: `status_code`, `response_time`, `header` (property = header name),
 * and `body`. A `body` assertion with a `property` set treats that property as
 * a JSON dot-path into the response body ("checks.database.latency_ms"), so
 * you can assert on a specific nested field - equality, a numeric comparison,
 * presence, or a substring - which is the health-check contract in
 * docs/monitors/health-checks.md. Without a property, `body` matches the whole
 * raw body (the original behavior).
 */

export interface AssertionSubject {
  statusCode: number
  headers: Record<string, string>
  body: string
  responseTimeMs: number
}

export interface AssertionRule {
  target: string
  property: string | null
  compare: string
  expected: string
}

/**
 * Resolve a dot-path from a JSON body. Returns undefined when the body is not
 * JSON, or the path (or any segment of it) is absent - callers treat undefined
 * as a missing asserted path.
 */
export function getJsonPath(rawBody: string, path: string): unknown {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  }
  catch {
    return undefined
  }
  if (!path)
    return parsed
  let current: unknown = parsed
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object')
      return undefined
    current = (current as Record<string, unknown>)[key]
    if (current === undefined)
      return undefined
  }
  return current
}

/** String form for equality/substring compares; objects/arrays are JSON-encoded. */
function comparable(value: unknown): string {
  if (value === null || value === undefined)
    return ''
  if (typeof value === 'object')
    return JSON.stringify(value)
  return String(value)
}

export function assertionActual(rule: AssertionRule, subject: AssertionSubject): unknown {
  switch (rule.target) {
    case 'status_code':
      return subject.statusCode
    case 'response_time':
      return subject.responseTimeMs
    case 'header':
      return subject.headers[(rule.property || '').toLowerCase()] ?? ''
    case 'body':
      return rule.property && rule.property.length > 0
        ? getJsonPath(subject.body, rule.property)
        : subject.body
    default:
      return ''
  }
}

/**
 * True when the assertion holds. A missing JSON dot-path (undefined) fails
 * every compare except `empty`, which is how you assert a field is absent -
 * matching the doc's "an asserted path is missing" alert. Numeric compares
 * coerce both sides with Number() and fail safe when either is unparseable.
 */
export function evaluateAssertion(rule: AssertionRule, subject: AssertionSubject): boolean {
  const actual = assertionActual(rule, subject)
  const missing = actual === undefined // only a missing JSON dot-path yields undefined

  switch (rule.compare) {
    case 'empty':
      return missing || actual === '' || actual === null
    case 'not_empty':
      return !(missing || actual === '' || actual === null)
    case 'eq':
      return !missing && comparable(actual) === rule.expected
    case 'not_eq':
      return !missing && comparable(actual) !== rule.expected
    case 'contains':
      return !missing && comparable(actual).includes(rule.expected)
    case 'not_contains':
      return !missing && !comparable(actual).includes(rule.expected)
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      if (missing)
        return false
      const a = Number(actual)
      const b = Number(rule.expected)
      if (Number.isNaN(a) || Number.isNaN(b))
        return false
      if (rule.compare === 'gt')
        return a > b
      if (rule.compare === 'gte')
        return a >= b
      if (rule.compare === 'lt')
        return a < b
      return a <= b
    }
    default:
      return false
  }
}

export function describeAssertion(rule: AssertionRule): string {
  if (rule.target === 'header')
    return `header "${rule.property}" ${rule.compare} "${rule.expected}"`
  if (rule.target === 'body' && rule.property && rule.property.length > 0)
    return `body path "${rule.property}" ${rule.compare} "${rule.expected}"`
  return `${rule.target.replace('_', ' ')} ${rule.compare} "${rule.expected}"`
}
