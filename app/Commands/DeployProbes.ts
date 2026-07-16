import type { CLI } from '@stacksjs/types'
import process from 'node:process'
import { ExitCode } from '@stacksjs/types'
import { probes } from '../../config/probes'

/**
 * `buddy deploy:probes` — reconcile the running probe fleet to `config/probes.ts`.
 *
 * The probe list is declarative: this command diffs it against the actual
 * Hetzner boxes labelled `app=uptime-status,role=probe` and applies the delta —
 *   - declared but not running  → PROVISION (worker-role deploy for its region)
 *   - running but not declared   → DECOMMISSION (destroy the server)
 *
 * Runs standalone and as the second half of push-to-deploy (see
 * .github/workflows/deploy.yml), so removing a probe from config tears its box
 * down on the next push — no manual `hcloud server delete` and no orphans.
 */
interface DeployProbesOptions {
  dryRun: boolean
  yes: boolean
}

const HCLOUD_API = 'https://api.hetzner.cloud/v1'
const PROJECT = 'uptime-status'

interface HetznerServer {
  id: number
  name: string
  labels: Record<string, string>
  public_net?: { ipv4?: { ip?: string } }
}

function token(): string {
  const t = process.env.HCLOUD_TOKEN || process.env.HETZNER_API_TOKEN
  if (!t) {
    console.error('✗ HCLOUD_TOKEN is not set — cannot reconcile the probe fleet.')
    process.exit(ExitCode.FatalError)
  }
  return t
}

async function hcloud<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${HCLOUD_API}${path}`, {
    ...init,
    headers: { 'Authorization': `Bearer ${token()}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (!res.ok && res.status !== 404) {
    const body = await res.text().catch(() => '')
    throw new Error(`Hetzner ${init?.method ?? 'GET'} ${path} → ${res.status}: ${body}`)
  }
  return (await res.json().catch(() => ({}))) as T
}

/** Every running probe box for this project (label-scoped — never matches other roles). */
async function runningProbes(): Promise<HetznerServer[]> {
  const selector = encodeURIComponent(`app=${PROJECT},role=probe`)
  const { servers } = await hcloud<{ servers: HetznerServer[] }>(`/servers?label_selector=${selector}`)
  return servers ?? []
}

async function destroyProbe(server: HetznerServer, dryRun: boolean): Promise<void> {
  const ip = server.public_net?.ipv4?.ip ?? '?'
  if (dryRun) {
    console.log(`  [dry-run] would DECOMMISSION ${server.name} (${ip}, id ${server.id})`)
    return
  }
  console.log(`  Decommissioning ${server.name} (${ip}, id ${server.id})…`)
  await hcloud(`/servers/${server.id}`, { method: 'DELETE' })
  console.log(`  ✓ Destroyed ${server.name}`)
}

async function provisionProbe(region: string, location: string, size: string, dryRun: boolean): Promise<void> {
  const cmd = `STATUS_DEPLOY_ROLE=worker HCLOUD_LOCATION=${location} WORKER_REGION=${region} ./buddy deploy --prod --yes`
  if (dryRun) {
    console.log(`  [dry-run] would PROVISION ${region} (${location}, ${size}) via: ${cmd}`)
    return
  }
  console.log(`  Provisioning probe ${region} (${location})…`)
  const proc = Bun.spawn(['sh', '-c', cmd], {
    cwd: process.cwd(),
    env: { ...process.env, STATUS_DEPLOY_ROLE: 'worker', HCLOUD_LOCATION: location, WORKER_REGION: region, PROBE_SIZE: size },
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const code = await proc.exited
  if (code !== 0)
    throw new Error(`worker deploy for ${region} exited ${code}`)
  console.log(`  ✓ Provisioned ${region}`)
}

export default function (cli: CLI) {
  cli
    .command('deploy:probes', 'Reconcile the Hetzner probe fleet to config/probes.ts')
    .option('--dry-run', 'Show the plan without provisioning or destroying anything', { default: false })
    .option('--yes', 'Apply without the interactive confirmation prompt', { default: false })
    .action(async (options: DeployProbesOptions) => {
      try {
        const declared = new Map(probes.map(p => [p.region, p]))
        const running = await runningProbes()
        const runningRegions = new Set(running.map(s => s.labels.region).filter(Boolean))

        const toDestroy = running.filter(s => !declared.has(s.labels.region))
        const toProvision = probes.filter(p => !runningRegions.has(p.region))

        console.log(`Probe fleet: ${declared.size} declared, ${running.length} running.`)
        if (toDestroy.length === 0 && toProvision.length === 0) {
          console.log('✓ Probe fleet already matches config — nothing to do.')
          process.exit(ExitCode.Success)
        }

        for (const s of toDestroy)
          console.log(`  → decommission ${s.name} (region ${s.labels.region || '?'})`)
        for (const p of toProvision)
          console.log(`  → provision ${p.region} (${p.location})`)

        // Destroying a box is irreversible; require --yes (or --dry-run) for it.
        if (toDestroy.length > 0 && !options.yes && !options.dryRun) {
          console.error(`✗ Refusing to decommission ${toDestroy.length} probe box(es) without --yes. Re-run with --yes.`)
          process.exit(ExitCode.FatalError)
        }

        for (const s of toDestroy)
          await destroyProbe(s, options.dryRun)
        for (const p of toProvision)
          await provisionProbe(p.region, p.location, p.size ?? 'micro', options.dryRun)

        console.log(options.dryRun ? '✓ Dry-run complete.' : '✓ Probe fleet reconciled.')
        process.exit(ExitCode.Success)
      }
      catch (error) {
        console.error(`✗ deploy:probes failed: ${error instanceof Error ? error.message : String(error)}`)
        process.exit(ExitCode.FatalError)
      }
    })
}
