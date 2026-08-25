import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * Internal navigation goes through `<StxLink to="…">`, never a plain
 * `<a href="/…">` — see AGENTS.md § Links for the rule and the reasoning.
 *
 * This is enforced rather than reviewed because the failure is invisible:
 * a plain anchor still navigates, so nothing looks broken. You just lose
 * the SPA transition on that one link, and the next person copies the
 * pattern from whatever file they happened to open. That is how the
 * pre-Phase-4 state (251 plain anchors, 0 StxLink) came about.
 *
 * A prior version of the rule exempted every cross-shell destination on
 * the theory that fragment-swapping between layouts would break. The
 * router already handles it: layouts in different groups trigger a full
 * document load. The exemptions below are the ones that survive that
 * check — cases where the destination is not a page at all, or where
 * interception would change what the link does.
 */
const VIEWS = join(import.meta.dir, '../../resources/views')

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

/** Opening `<a …>` tags carrying a root-relative href. */
function internalAnchors(source: string): string[] {
  return (source.match(/<a\b[^>]*\bhref\s*=\s*"\/[^"]*"[^>]*>/gi) ?? [])
}

function isAllowed(tag: string): boolean {
  const href = /\bhref\s*=\s*"([^"]*)"/.exec(tag)?.[1] ?? ''

  // Server routes, not pages. The SSO ones 302 to an identity provider.
  if (href.startsWith('/api/'))
    return true
  // Same-page hash — not a navigation at all.
  if (href.startsWith('/#'))
    return true
  // data-stx-link bypasses shouldIntercept, so an intercepted new-tab
  // link would open in place instead of in a new tab.
  if (/\btarget\s*=/i.test(tag))
    return true

  return false
}

describe('views use StxLink for internal navigation', () => {
  const files = stxFiles(VIEWS)

  test('the view tree is actually being scanned', () => {
    // Guards the walker itself: a bad path would make every assertion
    // below pass against an empty list.
    expect(files.length).toBeGreaterThan(40)
  })

  test('no plain <a href="/…"> outside the four documented exceptions', () => {
    const offenders: string[] = []

    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      for (const tag of internalAnchors(source)) {
        if (!isAllowed(tag))
          offenders.push(`${relative(VIEWS, file)}: ${tag.slice(0, 120)}`)
      }
    }

    expect(offenders).toEqual([])
  })

  test('nothing carries both StxLink and the router opt-out', () => {
    // StxLink IS the opt-in (config/ui.ts sets interceptAllLinks: false),
    // so data-no-router on one is a contradiction that reads as "this link
    // is deliberately excluded" while behaving as the opposite.
    const offenders: string[] = []

    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      for (const tag of source.match(/<StxLink\b[^>]*>/g) ?? []) {
        if (/\bdata-no-router\b/.test(tag))
          offenders.push(`${relative(VIEWS, file)}: ${tag.slice(0, 120)}`)
      }
    }

    expect(offenders).toEqual([])
  })

  test('every StxLink tag is closed', () => {
    // A stray </a> left behind by a hand conversion produces markup that
    // renders but nests wrongly, which is easy to miss in a browser.
    const offenders: string[] = []

    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      const open = (source.match(/<StxLink\b/g) ?? []).length
      const close = (source.match(/<\/StxLink>/g) ?? []).length
      if (open !== close)
        offenders.push(`${relative(VIEWS, file)}: ${open} open, ${close} close`)
    }

    expect(offenders).toEqual([])
  })
})
