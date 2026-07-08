import { describe, expect, test } from 'bun:test'
import { describeAssertion, evaluateAssertion, getJsonPath } from '../../app/lib/assertionEval'

const body = JSON.stringify({
  status: 'ok',
  version: '2.4.1',
  checks: {
    database: { status: 'ok', latency_ms: 12 },
    queue: { status: 'degraded', pending: 8421 },
  },
})
const subject = { statusCode: 200, headers: { 'content-type': 'application/json' }, body, responseTimeMs: 42 }
const bodyRule = (property: string, compare: string, expected: string) => ({ target: 'body', property, compare, expected })

describe('getJsonPath', () => {
  test('resolves nested paths to their values', () => {
    expect(getJsonPath(body, 'status')).toBe('ok')
    expect(getJsonPath(body, 'checks.database.latency_ms')).toBe(12)
    expect(getJsonPath(body, 'checks.queue.status')).toBe('degraded')
  })
  test('returns undefined for a missing path, non-JSON, or walking into a scalar', () => {
    expect(getJsonPath(body, 'checks.cache.status')).toBeUndefined()
    expect(getJsonPath(body, 'checks.database.missing')).toBeUndefined()
    expect(getJsonPath('not json', 'status')).toBeUndefined()
    expect(getJsonPath(body, 'status.deeper')).toBeUndefined()
  })
  test('an empty path returns the whole parsed object', () => {
    expect(getJsonPath('{"a":1}', '')).toEqual({ a: 1 })
  })
})

describe('evaluateAssertion — dot-path into the JSON body', () => {
  test('equality on a nested string', () => {
    expect(evaluateAssertion(bodyRule('checks.database.status', 'eq', 'ok'), subject)).toBe(true)
    expect(evaluateAssertion(bodyRule('checks.queue.status', 'eq', 'ok'), subject)).toBe(false)
  })
  test('numeric comparison on a nested number', () => {
    expect(evaluateAssertion(bodyRule('checks.database.latency_ms', 'lt', '100'), subject)).toBe(true)
    expect(evaluateAssertion(bodyRule('checks.queue.pending', 'lt', '5000'), subject)).toBe(false)
    expect(evaluateAssertion(bodyRule('checks.queue.pending', 'gt', '5000'), subject)).toBe(true)
  })
  test('presence via not_empty / empty', () => {
    expect(evaluateAssertion(bodyRule('version', 'not_empty', ''), subject)).toBe(true)
    expect(evaluateAssertion(bodyRule('missing.field', 'not_empty', ''), subject)).toBe(false)
    expect(evaluateAssertion(bodyRule('missing.field', 'empty', ''), subject)).toBe(true)
  })
  test('a missing asserted path fails every value compare (except empty)', () => {
    expect(evaluateAssertion(bodyRule('checks.cache.status', 'eq', 'ok'), subject)).toBe(false)
    expect(evaluateAssertion(bodyRule('checks.cache.latency', 'lt', '100'), subject)).toBe(false)
    expect(evaluateAssertion(bodyRule('checks.cache.status', 'contains', 'ok'), subject)).toBe(false)
  })
  test('substring match on a nested value', () => {
    expect(evaluateAssertion(bodyRule('version', 'contains', '2.4'), subject)).toBe(true)
    expect(evaluateAssertion(bodyRule('version', 'contains', '9.9'), subject)).toBe(false)
  })
})

describe('evaluateAssertion — non-body targets keep working', () => {
  test('status_code, response_time, header, and whole-body remain unchanged', () => {
    expect(evaluateAssertion({ target: 'status_code', property: null, compare: 'eq', expected: '200' }, subject)).toBe(true)
    expect(evaluateAssertion({ target: 'response_time', property: null, compare: 'lt', expected: '100' }, subject)).toBe(true)
    expect(evaluateAssertion({ target: 'header', property: 'Content-Type', compare: 'contains', expected: 'json' }, subject)).toBe(true)
    expect(evaluateAssertion({ target: 'body', property: null, compare: 'contains', expected: 'version' }, subject)).toBe(true)
  })
})

describe('describeAssertion', () => {
  test('names the body path, header, and plain targets', () => {
    expect(describeAssertion({ target: 'body', property: 'checks.queue.pending', compare: 'lt', expected: '5000' })).toBe('body path "checks.queue.pending" lt "5000"')
    expect(describeAssertion({ target: 'status_code', property: null, compare: 'eq', expected: '200' })).toBe('status code eq "200"')
    expect(describeAssertion({ target: 'header', property: 'x-foo', compare: 'eq', expected: 'bar' })).toBe('header "x-foo" eq "bar"')
  })
})
