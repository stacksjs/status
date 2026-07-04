// CSRF for server-rendered forms (stacksjs/status).
//
// The dashboard's `<form method="POST">` actions authenticate via the
// ambient HttpOnly `auth-token` cookie, so — unlike bearer-token API
// calls, which the CSRF middleware exempts — they need the double-submit
// CSRF token. The token is a stateless nonce (the server only checks that
// the `_token` field equals the `X-CSRF-Token` cookie), and the cookie is
// not HttpOnly, so the client can both read it and mint one when absent.
// Same-origin + SameSite=Lax keep a cross-site attacker from forging a
// matching cookie+field pair.
//
// This runs on every dashboard page: it guarantees the cookie exists and,
// on submit, stamps a fresh `_token` into every same-origin POST form —
// so no individual form template has to thread the token through itself.
(function () {
  function readCookie(name) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[.$?*|{}()\[\]\\\/+^]/g, '\\$&') + '=([^;]*)'))
    return m ? decodeURIComponent(m[1]) : null
  }

  function ensureToken() {
    var existing = readCookie('X-CSRF-Token')
    if (existing)
      return existing
    var arr = new Uint8Array(32)
    window.crypto.getRandomValues(arr)
    var tok = Array.prototype.map.call(arr, function (b) { return ('0' + b.toString(16)).slice(-2) }).join('')
    document.cookie = 'X-CSRF-Token=' + tok + '; Path=/; SameSite=Lax' + (location.protocol === 'https:' ? '; Secure' : '')
    return tok
  }

  // Seed on load so the cookie is present well before any submit.
  try { ensureToken() } catch (err) {}

  function stampForm(form) {
    // Only same-origin, state-mutating forms need a token.
    var method = (form.getAttribute('method') || 'get').toLowerCase()
    if (method === 'get')
      return
    var token = ensureToken()
    var field = form.querySelector('input[name="_token"]')
    if (!field) {
      field = document.createElement('input')
      field.type = 'hidden'
      field.name = '_token'
      form.appendChild(field)
    }
    field.value = token
  }

  // Capture-phase submit listener so the field is present before the
  // browser serializes the form (native submits and requestSubmit both
  // fire 'submit' first).
  document.addEventListener('submit', function (e) {
    if (e.target && e.target.tagName === 'FORM')
      stampForm(e.target)
  }, true)
})()
