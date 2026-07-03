/**
 * Normalizers for importing an existing status page from a competitor
 * service (stacksjs/status#1 Phase 12) — a one-time snapshot migration,
 * not an ongoing sync/proxy. Each provider's public (no-auth) JSON API
 * was verified live against a real hosted page before writing these
 * parsers — see the PR/commit this file was introduced in for the exact
 * response shapes checked. Status-string mapping intentionally falls
 * back to 'unknown' for anything unrecognized rather than guessing or
 * throwing — some of these enum spellings (Instatus, Better Stack) were
 * only independently confirmed for the "operational" happy path; the
 * non-operational values come from provider docs, not a live sample.
 */

export interface NormalizedComponent {
  name: string
  status: 'up' | 'down' | 'degraded' | 'unknown'
}

export interface NormalizedStatusPage {
  title: string
  components: NormalizedComponent[]
}

export type ImportProvider = 'statuspage' | 'instatus' | 'betterstack'

/** Lowercases and strips separators so "DEGRADED_PERFORMANCE" and "degradedPerformance" both match the same key. */
function normalizeStatusKey(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z]/g, '')
}

function mapStatus(raw: string | undefined | null, table: Record<string, NormalizedComponent['status']>): NormalizedComponent['status'] {
  if (!raw) return 'unknown'
  return table[normalizeStatusKey(raw)] ?? 'unknown'
}

const STATUSPAGE_STATUS_MAP: Record<string, NormalizedComponent['status']> = {
  operational: 'up',
  degradedperformance: 'degraded',
  partialoutage: 'degraded',
  majoroutage: 'down',
  undermaintenance: 'unknown',
}

const INSTATUS_STATUS_MAP: Record<string, NormalizedComponent['status']> = {
  operational: 'up',
  degradedperformance: 'degraded',
  partialoutage: 'degraded',
  majoroutage: 'down',
  undermaintenance: 'unknown',
}

const BETTERSTACK_STATUS_MAP: Record<string, NormalizedComponent['status']> = {
  operational: 'up',
  degraded: 'degraded',
  downtime: 'down',
  maintenance: 'unknown',
  notmonitored: 'unknown',
}

/**
 * Statuspage.io (Atlassian) — `{baseUrl}/api/v2/summary.json`. Works on
 * both the native *.statuspage.io subdomain and a status page's custom
 * domain (Statuspage-hosted pages route the same API through it).
 * `components[].group === true` entries are section headers, not real
 * components — excluded. `group_id` links a sub-component to its
 * section but we don't need it here (this is a flat import).
 */
async function fetchStatuspage(baseUrl: string): Promise<NormalizedStatusPage> {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/v2/summary.json`)
  if (!response.ok) throw new Error(`Statuspage.io summary.json responded ${response.status}`)
  const data = await response.json() as {
    page?: { name?: string }
    components?: Array<{ name?: string, status?: string, group?: boolean }>
  }

  return {
    title: data.page?.name ?? baseUrl,
    components: (data.components ?? [])
      .filter(c => c.group !== true)
      .map(c => ({ name: c.name ?? 'Unnamed component', status: mapStatus(c.status, STATUSPAGE_STATUS_MAP) })),
  }
}

/**
 * Instatus — page title from `{baseUrl}/summary.json`, components from
 * `{baseUrl}/v2/components.json`. Two separate requests: Instatus's
 * summary endpoint doesn't include the component list, and the
 * components endpoint doesn't include the page title.
 */
async function fetchInstatus(baseUrl: string): Promise<NormalizedStatusPage> {
  const base = baseUrl.replace(/\/$/, '')
  const [summaryRes, componentsRes] = await Promise.all([
    fetch(`${base}/summary.json`),
    fetch(`${base}/v2/components.json`),
  ])
  if (!summaryRes.ok) throw new Error(`Instatus summary.json responded ${summaryRes.status}`)
  if (!componentsRes.ok) throw new Error(`Instatus components.json responded ${componentsRes.status}`)

  const summary = await summaryRes.json() as { page?: { name?: string } }
  const componentsData = await componentsRes.json() as { components?: Array<{ name?: string, status?: string }> }

  return {
    title: summary.page?.name ?? baseUrl,
    components: (componentsData.components ?? [])
      .map(c => ({ name: c.name ?? 'Unnamed component', status: mapStatus(c.status, INSTATUS_STATUS_MAP) })),
  }
}

/**
 * Better Stack — `{baseUrl}/index.json`, JSON:API format. The page
 * record is `data`; components are `included` entries with
 * `type === 'status_page_resource'` (sections/categories are
 * `status_page_section` entries in the same array — not needed for a
 * flat import).
 */
async function fetchBetterStack(baseUrl: string): Promise<NormalizedStatusPage> {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/index.json`)
  if (!response.ok) throw new Error(`Better Stack index.json responded ${response.status}`)
  const data = await response.json() as {
    data?: { attributes?: { company_name?: string } }
    included?: Array<{ type?: string, attributes?: { public_name?: string, status?: string } }>
  }

  return {
    title: data.data?.attributes?.company_name ?? baseUrl,
    components: (data.included ?? [])
      .filter(item => item.type === 'status_page_resource')
      .map(item => ({
        name: item.attributes?.public_name ?? 'Unnamed component',
        status: mapStatus(item.attributes?.status, BETTERSTACK_STATUS_MAP),
      })),
  }
}

export async function fetchNormalizedStatusPage(provider: ImportProvider, baseUrl: string): Promise<NormalizedStatusPage> {
  switch (provider) {
    case 'statuspage': return fetchStatuspage(baseUrl)
    case 'instatus': return fetchInstatus(baseUrl)
    case 'betterstack': return fetchBetterStack(baseUrl)
    default: throw new Error(`Unknown import provider '${provider}'`)
  }
}
