/**
 * The request shape `resolveTeamContext()` expects, built from what an stx
 * server block is actually handed.
 *
 * Every dashboard page used to read its session cookie through
 * `globalThis.requestContext.cookie(name)` — a shim the dev/serve layers fill
 * via `AsyncLocalStorage.enterWith()` before handing control to stx. That
 * stopped working when stx's render moved into a different async context: the
 * store is no longer visible from inside a server block, so the shim returns
 * null for every cookie, and every visitor is resolved as a guest. Login was
 * never broken — API actions read the raw Request — but no page could read the
 * session login created.
 *
 * stx passes the parsed cookies into the server-block scope itself, so the
 * page can hand them in directly. That is the primary source here. The shim is
 * kept as a fallback for any serve path that populates it and not the scope
 * variable, which costs nothing when the cookies are already present.
 */

export interface CookieBag { [name: string]: string | undefined }

export interface CookieReadingRequest {
  cookies: { get: (name: string) => string | null }
}

export function authRequest(cookies?: CookieBag | null): CookieReadingRequest {
  return {
    cookies: {
      get(name: string): string | null {
        const direct = cookies?.[name]
        if (typeof direct === 'string' && direct !== '')
          return direct

        const shim = (globalThis as { requestContext?: { cookie?: (name: string) => string | null } }).requestContext
        const fallback = typeof shim?.cookie === 'function' ? shim.cookie(name) : null

        return typeof fallback === 'string' && fallback !== '' ? fallback : null
      },
    },
  }
}
