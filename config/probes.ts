/**
 * **Probe fleet** — the declarative source of truth for the secondary-region
 * check probes (queue-worker boxes) that feed multi-region consensus
 * (see config/regions.ts).
 *
 * Each entry is a Hetzner box deployed in `worker` role
 * (STATUS_DEPLOY_ROLE=worker), pulling check jobs off the primary's shared
 * Redis queue and writing region-tagged results.
 *
 * This list is RECONCILED by `buddy deploy:probes` (and push-to-deploy):
 *   - a probe listed here but with no running box is PROVISIONED
 *     (the worker-role deploy for its region/location);
 *   - a probe box that exists on Hetzner but is NO LONGER listed here is
 *     DECOMMISSIONED (its server is destroyed, freeing capacity).
 *
 * So adding/removing an entry is the whole workflow — deploy applies the diff.
 * Boxes are matched by the labels the worker deploy stamps:
 * `app=uptime-status, role=probe, region=<region>`.
 */
export interface Probe {
  /** Logical region tag — becomes WORKER_REGION + the box's `region` label. */
  region: string
  /** Hetzner datacenter location (e.g. `ash` = Ashburn/us-east, `nbg1` = Nuremberg). */
  location: string
  /** Provider-agnostic size; probes are light, so `micro` (cpx11) by default. */
  size?: 'nano' | 'micro' | 'small'
}

export const probes: Probe[] = [
  // us-east (ash) decommissioned 2026-07-16 to free Hetzner capacity.
  // Re-add to reprovision it:
  // { region: 'us-east', location: 'ash', size: 'micro' },
]

export default probes
