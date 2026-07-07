import { Action } from '@stacksjs/actions'
import { encrypt, verifyHash } from '@stacksjs/security'
import StatusPage from '../../Models/StatusPage'
import { isEmailDomainAllowed } from './AccessControl'

/**
 * The `redirect` field is attacker-controlled (it comes straight off the
 * unlock form) and lands in a 302 `Location` header — so an unsanitized value
 * is a classic open redirect (`?redirect=https://evil.com` phishes the visitor
 * right after they type the real password). Only same-origin, absolute-path
 * targets are allowed: a single leading slash, no scheme, no protocol-relative
 * `//host`, and no backslash (browsers normalize `\` to `/` in the authority).
 * Anything else falls back to the page's own URL.
 */
function safeRedirectPath(target: string, slug: string): string {
  const fallback = `/status/${slug}`
  if (!target.startsWith('/') || target.startsWith('//') || target.includes('\\'))
    return fallback
  return target
}

/**
 * `POST /status/{slug}/unlock` — the gate for StatusPage.accessType
 * 'password' and 'email_domain' (stacksjs/status#1 Phase 12).
 * 'ip_allowlist' needs no unlock step (it's checked per-request from the
 * request itself, not something a visitor logs into) and 'public' never
 * reaches this route.
 *
 * On success, sets an encrypted, HttpOnly cookie scoped to this specific
 * status page (`status_unlock_{slug}`) — unlocking one page never
 * unlocks another — and redirects back. On failure, redirects back with
 * `?unlock_error=1` so the gate view (which already has access to the
 * ambient query string) can show an inline error instead of a raw HTTP
 * error page.
 */
export default new Action({
  name: 'UnlockStatusPageAction',
  description: 'Unlock a password- or email-domain-gated status page',

  async handle(request) {
    const slug = String(request.get('slug') ?? '')
    const redirectTo = safeRedirectPath(String(request.get('redirect') ?? `/status/${slug}`), slug)

    const statusPage = await StatusPage.where('slug', slug).where('is_public', true).first()
    if (!statusPage)
      return new Response(null, { status: 404 })

    let unlocked = false

    if (statusPage.access_type === 'password') {
      const password = String(request.get('password') ?? '')
      unlocked = !!password && !!statusPage.password_hash && await verifyHash(password, statusPage.password_hash)
    }
    else if (statusPage.access_type === 'email_domain') {
      const email = String(request.get('email') ?? '')
      let allowedDomains: string[] = []
      try { allowedDomains = JSON.parse(statusPage.auth_email_domains || '[]') }
      catch { allowedDomains = [] }
      unlocked = !!email && isEmailDomainAllowed(email, allowedDomains)
    }

    if (!unlocked) {
      const sep = redirectTo.includes('?') ? '&' : '?'
      return new Response(null, { status: 302, headers: { Location: `${redirectTo}${sep}unlock_error=1` } })
    }

    const cookieValue = await encrypt(`unlock:${statusPage.id}`)
    return new Response(null, {
      status: 302,
      headers: {
        Location: redirectTo,
        'Set-Cookie': `status_unlock_${slug}=${encodeURIComponent(cookieValue)}; HttpOnly; Path=/; Max-Age=86400; SameSite=Lax`,
      },
    })
  },
})
