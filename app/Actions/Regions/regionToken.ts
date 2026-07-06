import process from 'node:process'

/**
 * Shared secret between the primary and every remote probe region. The
 * probe presents it in the URL (/regions/{token}/...) and the primary
 * checks it here. Set REGIONAL_INGEST_TOKEN on the primary (encrypted in
 * .env.production) and hand the same value to each region's probe.
 *
 * Returns false when the server has no token configured, so the regional
 * endpoints stay closed on a self-hosted / single-region install that never
 * sets one — they can't be hit with a guessed-empty token.
 */
export function regionTokenValid(candidate: unknown): boolean {
  const expected = process.env.REGIONAL_INGEST_TOKEN
  if (!expected || typeof candidate !== 'string' || candidate.length === 0)
    return false

  // Constant-time compare so a token can't be recovered byte-by-byte from
  // response timing. Length is compared first (unavoidably variable-time),
  // which only leaks the token's length — not its contents.
  if (candidate.length !== expected.length)
    return false
  let diff = 0
  for (let i = 0; i < expected.length; i++)
    diff |= candidate.charCodeAt(i) ^ expected.charCodeAt(i)
  return diff === 0
}
