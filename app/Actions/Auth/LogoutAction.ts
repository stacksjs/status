import { Action } from '@stacksjs/actions'
import { Auth } from '@stacksjs/auth'
import { response } from '@stacksjs/router'
import { clearAuthCookie } from './authCookie'

/**
 * Project override of the framework's default LogoutAction — same
 * token revocation, plus clearing the HttpOnly auth cookie LoginAction
 * sets (see its doc comment for why the cookie exists at all).
 */
export default new Action({
  name: 'LogoutAction',
  description: 'Logout from the application',
  method: 'POST',
  async handle(request: RequestInstance) {
    await Auth.logout()

    const clearCookie = clearAuthCookie()

    // The dashboard logs out via a plain <form method="POST"> (app-nav.stx) —
    // a full-page navigation, not an XHR — so returning JSON rendered the raw
    // `{"message":...}` payload in the browser. Redirect browser navigations
    // to /login; XHR/API callers (Accept: application/json) still get JSON,
    // so the SPA useAuth flow is unchanged.
    const accept = String(request.headers?.get?.('accept') ?? '')
    if (accept.includes('text/html')) {
      return new Response(null, {
        status: 302,
        headers: { 'Location': '/login', 'Set-Cookie': clearCookie },
      })
    }

    return response.json(
      { message: 'Successfully logged out' },
      { status: 200, headers: { 'Set-Cookie': clearCookie } },
    )
  },
})
