import { Buffer } from 'node:buffer'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import process from 'node:process'

/**
 * Symmetric encryption for cloud-provider secrets at rest (currently the AWS
 * secret access key stored by the settings page). AES-256-GCM: the GCM auth
 * tag makes a tampered ciphertext fail to decrypt rather than silently
 * returning garbage.
 *
 * The key is derived from APP_KEY (the same install secret that signs the SSO
 * flow cookie — see app/Actions/Auth/oidc.ts) via SHA-256 so any APP_KEY
 * length maps to the 32 bytes AES-256 needs. Rotating APP_KEY therefore
 * invalidates stored ciphertexts — acceptable for operator credentials that
 * are simply re-entered, and far better than committing plaintext AWS secrets
 * to the database.
 *
 * Wire format (all base64, dot-separated): iv.authTag.ciphertext — versioned
 * with a leading `v1:` so the scheme can change without ambiguity.
 */
const VERSION = 'v1'

function encryptionKey(): Buffer {
  const appKey = process.env.APP_KEY
  if (!appKey)
    throw new Error('APP_KEY must be set to encrypt cloud credentials')
  // APP_KEY is often `base64:...`; hashing the raw string is fine — we only
  // need a stable 32-byte key, not to interpret the base64 payload.
  return createHash('sha256').update(appKey).digest()
}

/** Encrypt a UTF-8 string to the versioned `v1:iv.tag.ciphertext` envelope. */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${VERSION}:${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`
}

/**
 * Decrypt a `v1:iv.tag.ciphertext` envelope back to its UTF-8 string. Returns
 * null on any malformed/tampered/wrong-key input rather than throwing, so a
 * caller (e.g. the automation that reads the AWS secret) can treat "can't
 * decrypt" the same as "not configured" instead of crashing.
 */
export function decryptSecret(envelope: string): string | null {
  try {
    if (!envelope.startsWith(`${VERSION}:`))
      return null
    const [ivB64, tagB64, dataB64] = envelope.slice(VERSION.length + 1).split('.')
    if (!ivB64 || !tagB64 || !dataB64)
      return null
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivB64, 'base64'))
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
    const dec = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()])
    return dec.toString('utf8')
  }
  catch {
    return null
  }
}

/**
 * Mask a secret for display — shows only the last 4 characters so the
 * settings page can confirm "a secret is stored" without ever re-emitting it.
 */
export function maskSecret(value: string): string {
  if (!value)
    return ''
  const tail = value.slice(-4)
  return `••••••••••••${tail}`
}
