// Browser-side WebAuthn helper for passkey enrollment + sign-in
// (stacksjs/status#1 Phase 9 follow-up). Pairs with the app-owned,
// spec-correct server verification in app/Actions/Security/webauthn.ts.
//
// Standard base64url-of-raw-bytes challenge convention on both ends (the
// challenge is a BufferSource for the authenticator; the browser echoes
// base64url(challenge) into clientDataJSON, which the server compares
// against its stored copy). Registration ships getAuthenticatorData() +
// getPublicKey() (SPKI) rather than the CBOR attestationObject, matching
// what the server verifies. Plain script (no bundler): exposes
// window.stacksPasskey.
;(function () {
  function bytesToB64url(buf) {
    const bytes = new Uint8Array(buf)
    let str = ''
    for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i])
    return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
  }

  function b64urlToBytes(s) {
    let b64 = String(s).replace(/-/g, '+').replace(/_/g, '/')
    while (b64.length % 4) b64 += '='
    const bin = atob(b64)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  }

  function isSupported() {
    return typeof window.PublicKeyCredential === 'function'
      && typeof navigator.credentials === 'object'
      && typeof navigator.credentials.create === 'function'
  }

  async function postJson(url, csrfToken, body) {
    const headers = { 'Content-Type': 'application/json' }
    if (csrfToken) headers['x-csrf-token'] = csrfToken
    const res = await fetch(url, {
      method: 'POST',
      headers: headers,
      credentials: 'same-origin',
      body: body ? JSON.stringify(body) : '{}',
    })
    let data = {}
    try { data = await res.json() } catch (e) {}
    return { ok: res.ok, status: res.status, data: data }
  }

  // Enroll a new passkey for the signed-in user.
  async function register(optionsUrl, verifyUrl, csrfToken) {
    if (!isSupported()) return { ok: false, error: 'This browser does not support passkeys.' }

    var opt = await postJson(optionsUrl, csrfToken, {})
    if (!opt.ok) return { ok: false, error: (opt.data && opt.data.error) || 'Could not start enrollment.' }
    var o = opt.data

    var publicKey = {
      challenge: b64urlToBytes(o.challenge),
      rp: o.rp,
      user: {
        id: b64urlToBytes(o.user.id),
        name: o.user.name,
        displayName: o.user.displayName,
      },
      pubKeyCredParams: o.pubKeyCredParams,
      authenticatorSelection: o.authenticatorSelection,
      timeout: o.timeout,
      attestation: 'none',
      excludeCredentials: (o.excludeCredentials || []).map(function (c) {
        return { id: b64urlToBytes(c.id), type: 'public-key', transports: c.transports }
      }),
    }

    var cred
    try {
      cred = await navigator.credentials.create({ publicKey: publicKey })
    }
    catch (e) {
      return { ok: false, error: e && e.name === 'InvalidStateError'
        ? 'This device already has a passkey for your account.'
        : 'Passkey creation was cancelled.' }
    }
    if (!cred) return { ok: false, error: 'Passkey creation was cancelled.' }

    var r = cred.response
    var body = {
      id: cred.id,
      deviceType: (cred.authenticatorAttachment === 'cross-platform') ? 'cross-platform' : 'platform',
      response: {
        clientDataJSON: bytesToB64url(r.clientDataJSON),
        authenticatorData: bytesToB64url(r.getAuthenticatorData()),
        publicKey: bytesToB64url(r.getPublicKey()),
        publicKeyAlgorithm: r.getPublicKeyAlgorithm(),
        transports: (typeof r.getTransports === 'function') ? r.getTransports() : [],
      },
    }

    var ver = await postJson(verifyUrl, csrfToken, body)
    if (!ver.ok || !ver.data || !ver.data.verified)
      return { ok: false, error: (ver.data && ver.data.error) || 'Could not verify the passkey.' }
    return { ok: true }
  }

  // Passwordless sign-in with a passkey.
  async function login(optionsUrl, verifyUrl, csrfToken) {
    if (!isSupported()) return { ok: false, error: 'This browser does not support passkeys.' }

    var opt = await postJson(optionsUrl, csrfToken, {})
    if (!opt.ok) return { ok: false, error: (opt.data && opt.data.error) || 'Could not start sign-in.' }
    var o = opt.data

    var publicKey = {
      challenge: b64urlToBytes(o.challenge),
      rpId: o.rpId,
      allowCredentials: (o.allowCredentials || []).map(function (c) {
        return { id: b64urlToBytes(c.id), type: 'public-key', transports: c.transports }
      }),
      userVerification: o.userVerification,
      timeout: o.timeout,
    }

    var cred
    try {
      cred = await navigator.credentials.get({ publicKey: publicKey })
    }
    catch (e) {
      return { ok: false, error: 'Passkey sign-in was cancelled.' }
    }
    if (!cred) return { ok: false, error: 'Passkey sign-in was cancelled.' }

    var r = cred.response
    var body = {
      id: cred.id,
      response: {
        clientDataJSON: bytesToB64url(r.clientDataJSON),
        authenticatorData: bytesToB64url(r.authenticatorData),
        signature: bytesToB64url(r.signature),
        userHandle: r.userHandle ? bytesToB64url(r.userHandle) : null,
      },
    }

    var ver = await postJson(verifyUrl, csrfToken, body)
    if (!ver.ok || !ver.data || !(ver.data.token || ver.data.access_token))
      return { ok: false, error: (ver.data && ver.data.error) || 'Could not verify the passkey.' }
    return { ok: true, data: ver.data }
  }

  window.stacksPasskey = { isSupported: isSupported, register: register, login: login }
})()
