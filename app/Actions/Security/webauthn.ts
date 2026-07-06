/**
 * Self-contained, spec-correct WebAuthn verification for this app
 * (stacksjs/status#1 Phase 9 follow-up — passkeys end to end).
 *
 * Deliberately does NOT use @stacksjs/ts-auth's verifyRegistrationResponse
 * / verifyAuthenticationResponse: at v0.4.3 those are broken in ways that
 * make a real browser ceremony impossible — the challenge comparison
 * requires a non-standard `TextEncoder(base64(challenge))` client
 * convention, the attestation parser does no CBOR decoding (so a genuine
 * attestationObject fails the rpIdHash check), the returned public key is
 * COSE-CBOR while the authentication verifier re-imports it as SPKI, and
 * assertion signatures are passed to WebCrypto as ASN.1 DER when it needs
 * raw P1363. Rather than couple this app to those bugs, we verify against
 * the plain WebAuthn data the browser already hands us:
 * `getAuthenticatorData()` (a fixed binary layout — no CBOR) and
 * `getPublicKey()` (SPKI DER), plus `clientDataJSON`. The only crypto is
 * one WebCrypto ECDSA P-256 verify of the assertion signature, which is
 * the actual security check.
 *
 * Client and server both use the standard base64url-of-raw-bytes
 * challenge convention, so this stays correct if ts-auth is later fixed.
 */

// ---------------------------------------------------------------------------
// base64url (binary-safe — ts-auth's base64UrlDecode returns a lossy UTF-8
// string, unusable for keys/signatures/authData).
// ---------------------------------------------------------------------------

export function base64urlToBytes(input: string): Uint8Array {
  // Buffer.from accepts the URL-safe alphabet and tolerates missing padding.
  return new Uint8Array(Buffer.from(input, 'base64url'))
}

export function bytesToBase64url(input: ArrayBuffer | Uint8Array): string {
  const buf = input instanceof Uint8Array ? input : new Uint8Array(input)
  return Buffer.from(buf).toString('base64url')
}

/** Exact-sized ArrayBuffer (never the pooled slab behind a Buffer). */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

// ---------------------------------------------------------------------------
// Parsed shapes
// ---------------------------------------------------------------------------

export interface ClientData {
  type: string
  challenge: string
  origin: string
}

export interface AuthenticatorData {
  rpIdHash: Uint8Array
  userPresent: boolean
  userVerified: boolean
  signCount: number
}

export function decodeClientData(clientDataJSONb64url: string): ClientData {
  const json = new TextDecoder().decode(base64urlToBytes(clientDataJSONb64url))
  const parsed = JSON.parse(json)
  return { type: String(parsed.type), challenge: String(parsed.challenge), origin: String(parsed.origin) }
}

/**
 * Parse the fixed-layout authenticator data structure. No CBOR: the
 * attested-credential-data / extensions tail (which would need CBOR) is
 * not needed here — we take the credential id and public key from the
 * browser's own `getPublicKey()` at registration, and login only needs
 * rpIdHash + flags + signCount, all in the fixed 37-byte prefix.
 */
export function parseAuthenticatorData(bytes: Uint8Array): AuthenticatorData {
  if (bytes.byteLength < 37)
    throw new Error('authenticatorData too short')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const rpIdHash = bytes.slice(0, 32)
  const flags = view.getUint8(32)
  const signCount = view.getUint32(33, false)
  return {
    rpIdHash,
    userPresent: (flags & 0x01) !== 0,
    userVerified: (flags & 0x04) !== 0,
    signCount,
  }
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', toArrayBuffer(data))
  return new Uint8Array(digest)
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength)
    return false
  let diff = 0
  for (let i = 0; i < a.byteLength; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}

// ---------------------------------------------------------------------------
// Shared ceremony checks (clientDataJSON): type, challenge, origin.
// ---------------------------------------------------------------------------

export interface CeremonyExpectation {
  type: 'webauthn.create' | 'webauthn.get'
  challengeB64url: string
  origin: string
  rpId: string
}

export function verifyClientData(client: ClientData, expected: CeremonyExpectation): string | null {
  if (client.type !== expected.type)
    return `unexpected ceremony type '${client.type}'`
  // Both sides are base64url of the same raw challenge bytes (standard
  // convention) — a constant-time-ish string compare is fine, the value
  // is a public nonce.
  if (client.challenge !== expected.challengeB64url)
    return 'challenge mismatch'
  if (client.origin !== expected.origin)
    return `origin mismatch (got '${client.origin}')`
  return null
}

/** rpIdHash in the authenticator data must be SHA-256(rpId). */
export async function verifyRpIdHash(authData: AuthenticatorData, rpId: string): Promise<boolean> {
  const expected = await sha256(new TextEncoder().encode(rpId))
  return bytesEqual(authData.rpIdHash, expected)
}

// ---------------------------------------------------------------------------
// Assertion signature verification (login).
// ---------------------------------------------------------------------------

/**
 * Convert an ASN.1 DER ECDSA signature (`30 len 02 rlen r 02 slen s`) to
 * raw IEEE-P1363 `r||s` (64 bytes for P-256), which is what WebCrypto's
 * ECDSA verify expects. Authenticators emit DER.
 */
export function derToP1363(der: Uint8Array): Uint8Array {
  let offset = 0
  if (der[offset++] !== 0x30)
    throw new Error('invalid DER: no SEQUENCE')
  // Sequence length (short form is all we ever see for P-256).
  if (der[offset]! & 0x80) {
    const n = der[offset++]! & 0x7f
    offset += n
  }
  else {
    offset++
  }
  const readInt = (): Uint8Array => {
    if (der[offset++] !== 0x02)
      throw new Error('invalid DER: no INTEGER')
    const len = der[offset++]!
    let val = der.slice(offset, offset + len)
    offset += len
    // Strip a leading 0x00 sign byte, then left-pad to 32.
    while (val.byteLength > 32 && val[0] === 0x00) val = val.slice(1)
    const out = new Uint8Array(32)
    out.set(val, 32 - val.byteLength)
    return out
  }
  const r = readInt()
  const s = readInt()
  const p1363 = new Uint8Array(64)
  p1363.set(r, 0)
  p1363.set(s, 32)
  return p1363
}

/**
 * Verify a WebAuthn assertion signature. `spkiPublicKey` is the SPKI DER
 * the browser gave us via `getPublicKey()` at registration; `signature`
 * is the authenticator's DER signature. The signed message is
 * `authenticatorData || SHA-256(clientDataJSON)`.
 */
export async function verifyAssertionSignature(params: {
  spkiPublicKey: Uint8Array
  authenticatorData: Uint8Array
  clientDataJSON: Uint8Array
  signature: Uint8Array
}): Promise<boolean> {
  let key: CryptoKey
  try {
    key = await crypto.subtle.importKey(
      'spki',
      toArrayBuffer(params.spkiPublicKey),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    )
  }
  catch {
    return false
  }

  const clientHash = await sha256(params.clientDataJSON)
  const signed = new Uint8Array(params.authenticatorData.byteLength + clientHash.byteLength)
  signed.set(params.authenticatorData, 0)
  signed.set(clientHash, params.authenticatorData.byteLength)

  let sig: Uint8Array
  try {
    sig = derToP1363(params.signature)
  }
  catch {
    return false
  }

  try {
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      toArrayBuffer(sig),
      toArrayBuffer(signed),
    )
  }
  catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Relying-party identity from config/env. rpId and origin come from the
// SERVER, never the request Origin header (which an attacker controls).
// ---------------------------------------------------------------------------

export function relyingParty(): { rpId: string, origin: string } {
  const envRpId = process.env.WEBAUTHN_RP_ID
  const envOrigin = process.env.WEBAUTHN_ORIGIN

  // config.app.url is a bare host in this app (e.g. 'status.localhost'),
  // sometimes with a scheme. Normalize to host-only for rpId and a full
  // origin for the origin check.
  const rawUrl = String(process.env.APP_URL || 'localhost')
  const withScheme = rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`
  let host = 'localhost'
  let origin = withScheme
  try {
    const u = new URL(withScheme)
    host = u.hostname
    origin = u.origin
  }
  catch {
    // keep defaults
  }

  return {
    rpId: envRpId || host,
    origin: envOrigin || origin,
  }
}
