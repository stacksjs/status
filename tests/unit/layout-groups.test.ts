import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

/**
 * A page's layout group decides whether navigating to it reloads the
 * document or just swaps the routed container.
 *
 * The stx client router reads X-STX-Layout-Group off the fragment response
 * and compares it to the current page's. Same group means same shell, so it
 * swaps only the routed <main> and leaves everything outside it alone —
 * including the navbar. Different group means full page load.
 *
 * The group is derived from the page's layout FILE, and a page with no
 * layout falls back to 'default'. index.stx had no layout, because it owns
 * its whole document (coming-soon mode screen, host-derived lang/theme) and
 * does not fit layouts/marketing.stx. layouts/default.stx is what the entire
 * dashboard resolves to. So the homepage and /dashboard/* both advertised
 * 'default', the router read them as one shell, and clicking "Dashboard"
 * from the homepage swapped the content in under the marketing navbar — you
 * landed on the dashboard still being offered a button to go there.
 *
 * layouts/home.stx exists to give the homepage a name of its own. These
 * tests keep it that way, and guard the trap that conversion sprang: when a
 * page extends a layout, its relative @include paths resolve from the
 * LAYOUT's directory, so index.stx's './partials/...' silently became
 * 'resources/views/layouts/partials/...' and every include failed.
 */
const VIEWS = join(import.meta.dir, '../../resources/views')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      // Layouts and partials are not routable, so they have no group of
      // their own — they contribute theirs to the pages that use them.
      if (entry !== 'layouts' && entry !== 'partials') walk(full, out)
    }
    else if (entry.endsWith('.stx')) {
      out.push(full)
    }
  }
  return out
}

interface Page {
  path: string
  layout: string | null
  group: string
  /** Which navbar this page ends up rendering, via itself or its layout. */
  nav: 'marketing' | 'app' | null
}

const pages: Page[] = walk(VIEWS).map((path) => {
  const src = readFileSync(path, 'utf8')
  const layout = src.match(/@extends\('([^']+)'\)/)?.[1] ?? null

  // Mirror the framework's own fallback: no layout resolves to 'default'.
  const group = layout ? basename(layout).replace(/\.stx$/, '') : 'default'

  const layoutSrc = layout ? readFileSync(join(VIEWS, `${layout.replace(/^layouts\//, 'layouts/')}.stx`), 'utf8') : ''
  const combined = src + layoutSrc
  const nav = combined.includes('partials/app-nav.stx')
    ? 'app' as const
    : combined.includes('partials/marketing-nav.stx') ? 'marketing' as const : null

  return { path: path.slice(VIEWS.length + 1), layout, group, nav }
})

describe('layout groups', () => {
  test('pages exist to check', () => {
    expect(pages.length).toBeGreaterThan(40)
  })

  test('one group never spans two different navbars', () => {
    // The invariant that actually matters. Pages sharing a group are
    // fragment-swapped into each other's document, so they must already
    // agree on everything outside the routed container — the navbar most
    // visibly of all.
    const navsByGroup = new Map<string, Set<string>>()
    for (const page of pages) {
      if (!page.nav) continue
      if (!navsByGroup.has(page.group)) navsByGroup.set(page.group, new Set())
      navsByGroup.get(page.group)!.add(page.nav)
    }

    for (const [group, navs] of navsByGroup) {
      const offenders = pages.filter(p => p.group === group && p.nav).map(p => `${p.path} (${p.nav})`)
      expect(`${group}: ${[...navs].sort().join('+')} — ${navs.size === 1 ? 'ok' : offenders.join(', ')}`)
        .toBe(`${group}: ${[...navs].sort().join('+')} — ok`)
    }
  })

  test('the homepage does not share the dashboard group', () => {
    // The specific regression: both were 'default'.
    const home = pages.find(p => p.path === 'index.stx')!
    const dashboards = pages.filter(p => p.path.startsWith('dashboard/'))

    expect(home.layout).toBe('layouts/home')
    expect(dashboards.length).toBeGreaterThan(5)
    for (const page of dashboards)
      expect(`${page.path}: ${page.group === home.group ? 'COLLIDES' : 'distinct'}`).toBe(`${page.path}: distinct`)
  })

  test('a page that extends a layout resolves includes from the layout dir', () => {
    // Relative includes in a section resolve against the LAYOUT's directory,
    // not the page's — which is why every converted page under
    // resources/views/ writes '../partials/…'. A './partials/…' here loads
    // nothing and the page renders an include error where its head or nav
    // should be.
    for (const page of pages) {
      if (!page.layout) continue
      const src = readFileSync(join(VIEWS, page.path), 'utf8')
      const bad = [...src.matchAll(/@include\('(\.\/[^']+)'\)/g)].map(m => m[1])
      expect(`${page.path}: ${bad.length ? bad.join(', ') : 'no ./ includes'}`)
        .toBe(`${page.path}: no ./ includes`)
    }
  })

  test('every document-owning source gives the router a container', () => {
    // Matching groups are only half of what a fragment swap needs: the
    // router also has to find somewhere to put the incoming HTML. It
    // resolves that as
    //   querySelector(containerSel) || '[data-stx-content]' || 'main'
    // and config/ui.ts sets no container override, so the default 'main'
    // applies. When nothing matches it takes the
    //   if (!newContent) { location.href = url }
    // branch — a silent fall back to a full page load. Nothing errors,
    // nothing logs; StxLink just stops being SPA, which is exactly how
    // this shipped unnoticed on /login, /register and /status/*: those
    // layouts wrote @yield('content') straight into <body> with no <main>
    // around it, so every same-group link on them full-loaded.
    //
    // Only sources that own a document are checked. A fragment page (no
    // <body> of its own) is wrapped by the framework's generated shell,
    // which supplies [data-stx-content] itself — invite/[uuid].stx relies
    // on that, and its rendered output really does carry the attribute.
    const layoutDir = join(VIEWS, 'layouts')
    const sources = [
      ...walk(VIEWS),
      ...readdirSync(layoutDir).filter(f => f.endsWith('.stx')).map(f => join(layoutDir, f)),
    ]

    for (const full of sources) {
      // Markup only. Prose and code quote these tags without emitting
      // them — invite/[uuid].stx documents itself as "no <!DOCTYPE>/
      // <html>/<head>/<body>" in a server-script comment, and the note on
      // layouts/auth.stx's own `main` rule sits inside its <style>.
      const markup = readFileSync(full, 'utf8')
        .replace(/\{\{--[\s\S]*?--\}\}/g, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<style\b[\s\S]*?<\/style>/gi, '')
        .replace(/<script\b[\s\S]*?<\/script>/gi, '')

      if (!/<body\b/.test(markup)) continue

      const path = full.slice(VIEWS.length + 1)
      const ok = /<main\b/.test(markup) || /data-stx-content/.test(markup)
      expect(`${path}: ${ok ? 'has a routed container' : 'NO ROUTED CONTAINER'}`)
        .toBe(`${path}: has a routed container`)
    }
  })

  test('every layout a page names actually exists', () => {
    for (const page of pages) {
      if (!page.layout) continue
      const exists = (() => {
        try {
          readFileSync(join(VIEWS, `${page.layout}.stx`), 'utf8')
          return true
        }
        catch {
          return false
        }
      })()
      expect(`${page.path} -> ${page.layout}: ${exists}`).toBe(`${page.path} -> ${page.layout}: true`)
    }
  })
})
