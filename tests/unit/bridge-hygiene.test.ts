import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'bun:test'

/**
 * Bridge hygiene: no server binding may leak into served HTML.
 *
 * stx's server->client data bridge (pantry/@stacksjs/stx/dist/
 * client-script.js, generateServerDataBridge) serializes ANY server-block
 * binding into a `var name = <JSON>` line in the page when three things
 * hold: the name does not start with `__` or `$` (extractBridgeData skips
 * those, and skips functions), the name word-matches the text of a plain
 * <script> block (a URL string like '/api/passkeys/...' counts), and the
 * script does not redeclare the name. That word-match is how raw monitor
 * rows carrying metrics_token ended up in dashboard HTML (fixed in the
 * same commit that adds this test).
 *
 * This test statically replays those rules over every view (with
 * @include partials flattened in, since the bridge sees the assembled
 * page) and fails on any would-be emission. Fix a failure by renaming the
 * server binding to a `__` prefix (server-only by contract) and/or
 * projecting rows down to display fields — never by allowlisting secrets.
 */

const VIEWS_ROOT = resolve(import.meta.dir, '../../resources/views')

/**
 * Bindings that are provably harmless to emit AND awkward to rename.
 * Keep this list empty unless a false positive genuinely cannot be
 * resolved by a rename; every entry must carry a justification.
 */
const ALLOWLIST: Record<string, string[]> = {}

function stxFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...stxFiles(p))
    else if (name.endsWith('.stx')) out.push(p)
  }
  return out
}

/** Flatten relative @include('...') calls the way the renderer assembles the page. */
function flatten(file: string, depth = 0, seen = new Set<string>()): string {
  if (depth > 6 || seen.has(file)) return ''
  seen.add(file)
  let src: string
  try {
    src = readFileSync(file, 'utf8')
  } catch {
    return ''
  }
  return src.replace(/@include\(\s*['"]([^'"]+)['"]\s*\)/g, (whole, incPath: string) => {
    if (!incPath.includes('/') && !incPath.endsWith('.stx')) return whole // named/layout include, not a relative path
    const target = resolve(dirname(file), incPath)
    return flatten(target, depth + 1, seen)
  })
}

interface ServerBinding { name: string, isFunctionLike: boolean }

function serverBindings(flattened: string): ServerBinding[] {
  const bindings: ServerBinding[] = []
  const blocks = [...flattened.matchAll(/<script\s+server[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1])
  for (const block of blocks) {
    // Only column-0 declarations: module-scope code in this repo's server
    // blocks is written unindented, and only module-scope bindings survive
    // into the bridged server scope (function-locals never do). An indented
    // top-level decl would slip past this scan — keep server blocks
    // conventionally formatted.
    // The bridge skips typeof === 'function' values, so record whether the
    // initializer is function-like (heuristic on the declaration line; a
    // miss errs toward flagging, never toward leaking).
    for (const m of block.matchAll(/^(?:export\s+)?(const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^\n]*)/gm)) {
      const init = m[3]
      const isFn = /^\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/.test(init)
      bindings.push({ name: m[2], isFunctionLike: isFn })
    }
    // Bare declarations without initializer (`let x`):
    for (const m of block.matchAll(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*$/gm))
      bindings.push({ name: m[1], isFunctionLike: false })
    // Destructured requires/objects: `const { db, config } = require(...)`.
    // These are live objects (query builders, the full app config) and the
    // bridge will happily JSON.stringify them.
    for (const m of block.matchAll(/^(?:export\s+)?(?:const|let|var)\s*\{([^}]+)\}/gm)) {
      for (const raw of m[1].split(',')) {
        const name = raw.split(':').pop()!.trim()
        if (/^[A-Za-z_$][\w$]*$/.test(name)) bindings.push({ name, isFunctionLike: false })
      }
    }
    // Function declarations are never bridged (typeof function).
    for (const m of block.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm))
      bindings.push({ name: m[1], isFunctionLike: true })
  }
  return bindings
}

function plainScripts(flattened: string): string {
  // Remove server blocks first so their bodies are not scanned as client text.
  const withoutServer = flattened.replace(/<script\s+server[^>]*>[\s\S]*?<\/script>/g, '')
  const scripts = [...withoutServer.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)]
    .filter(m => !/\bserver\b/.test(m[1]))
    .map(m => m[2])
  // {{ ... }} interpolations are replaced by JSON values before the bridge
  // scans the script, so the expression text inside them never word-matches.
  return scripts.join('\n').replace(/\{\{[\s\S]*?\}\}/g, ' ')
}

describe('server->client bridge hygiene', () => {
  const violations: string[] = []

  for (const file of stxFiles(VIEWS_ROOT)) {
    const rel = file.slice(VIEWS_ROOT.length + 1)
    const flattened = flatten(file)
    const scripts = plainScripts(flattened)
    if (!scripts.trim()) continue
    const allowed = ALLOWLIST[rel] ?? []

    for (const b of serverBindings(flattened)) {
      if (b.isFunctionLike) continue
      if (b.name.startsWith('__') || b.name.startsWith('$')) continue
      if (allowed.includes(b.name)) continue
      if (!new RegExp(`\\b${b.name}\\b`).test(scripts)) continue
      if (new RegExp(`(?:const|let|var|function|class)\\s+${b.name}\\b`).test(scripts)) continue
      violations.push(`${rel}: server binding \`${b.name}\` would be serialized into page HTML (word-matched by a plain <script>) — rename it with a \`__\` prefix or project/redeclare it`)
    }
  }

  it('no server binding is emitted into page HTML by the data bridge', () => {
    expect(violations).toEqual([])
  })
})
