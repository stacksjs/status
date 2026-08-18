import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { authRequest } from '../../app/lib/authRequest'

/**
 * How a dashboard page reads the session cookie.
 *
 * This is the shape of a bug that shipped silently: every page read its cookie
 * through `globalThis.requestContext.cookie(name)`, a shim filled by
 * `AsyncLocalStorage.enterWith()` in the serve layer. When stx's render moved
 * into a different async context the store stopped being visible from inside a
 * server block, so the shim returned null for every cookie and every visitor
 * resolved as a guest. Login itself was fine — API actions read the raw
 * Request — so the failure looked like "sessions are not created" rather than
 * "pages cannot read them", which is a much harder thing to go looking for.
 *
 * Nothing in the suite noticed, because no test renders a page with a cookie.
 * The static check below is the cheap half of that gap: it fails if a view
 * goes back to reading cookies from the shim.
 */

const VIEWS = resolve(import.meta.dir, '../../resources/views')

function stxFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory())
      out.push(...stxFiles(full))
    else if (entry.endsWith('.stx'))
      out.push(full)
  }
  return out
}

describe('authRequest', () => {
  afterEach(() => {
    delete (globalThis as { requestContext?: unknown }).requestContext
  })

  test('prefers the cookies stx hands the server block', () => {
    const request = authRequest({ 'auth-token': 'from-stx' })

    expect(request.cookies.get('auth-token')).toBe('from-stx')
  })

  test('falls back to the global shim when the scope has nothing', () => {
    // Kept for any serve path that fills the shim and not the scope variable.
    ;(globalThis as { requestContext?: unknown }).requestContext = { cookie: (n: string) => (n === 'auth-token' ? 'from-shim' : null) }

    expect(authRequest(null).cookies.get('auth-token')).toBe('from-shim')
    expect(authRequest({}).cookies.get('auth-token')).toBe('from-shim')
  })

  test('the scope wins over the shim when both have a value', () => {
    ;(globalThis as { requestContext?: unknown }).requestContext = { cookie: () => 'stale' }

    expect(authRequest({ 'auth-token': 'fresh' }).cookies.get('auth-token')).toBe('fresh')
  })

  test('an empty string is not a session', () => {
    // A blank cookie must not resolve as a token, or it becomes a lookup for
    // `''` against the token table rather than an unauthenticated request.
    expect(authRequest({ 'auth-token': '' }).cookies.get('auth-token')).toBeNull()
  })

  test('no cookies anywhere is null, not undefined', () => {
    expect(authRequest(null).cookies.get('auth-token')).toBeNull()
    expect(authRequest(undefined).cookies.get('nope')).toBeNull()
  })

  test('a shim without a cookie() function does not throw', () => {
    // Partially-initialised serve layers exist; auth must degrade to
    // "unauthenticated", never to a 500 on every page.
    ;(globalThis as { requestContext?: unknown }).requestContext = {}

    expect(authRequest(null).cookies.get('auth-token')).toBeNull()
  })
})

describe('views read cookies from the server-block scope', () => {
  test('no view resolves auth through the async-context shim', () => {
    const offenders = stxFiles(VIEWS)
      .filter(file => readFileSync(file, 'utf8').includes('globalThis.requestContext'))
      .map(file => file.slice(VIEWS.length + 1))

    expect(offenders).toEqual([])
  })

  test('every view that resolves a team context passes authRequest()', () => {
    const offenders = stxFiles(VIEWS)
      .filter((file) => {
        const source = readFileSync(file, 'utf8')
        return source.includes('resolveTeamContext(') && !source.includes('authRequest(')
      })
      .map(file => file.slice(VIEWS.length + 1))

    expect(offenders).toEqual([])
  })
})
