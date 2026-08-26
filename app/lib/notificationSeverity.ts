/**
 * Per-channel severity routing (stacksjs/status#1). Each channel attached to a
 * monitor can fire on hard "down" outages only, soft "issue" events only
 * (slow responses, SSL expiring soon, DNS drift, blocklistings), or both -
 * so a critical production API can page the whole team on `down` while a
 * quieter channel like email only hears about issues. This module is the
 * single source of that classification and the fires-on match, shared by the
 * incident notification listeners and the SSL/domain warning fan-outs.
 */

/**
 * Monitor types whose incidents are soft "issues" (degraded) rather than hard
 * "down" outages. Mirrors the wording split in SendIncidentNotification: a
 * blocklisting, broken link, Lighthouse/perf regression, or DNS drift is an
 * issue, everything else reads as down.
 */
export const ISSUE_MONITOR_TYPES = new Set(['dns_blocklist', 'broken_links', 'lighthouse', 'performance', 'dns'])

export type IncidentSeverity = 'down' | 'issue'
export type FiresOn = 'down' | 'issue' | 'both'

/** The severity an incident of the given monitor type represents. */
export function incidentSeverityForType(monitorType: string): IncidentSeverity {
  return ISSUE_MONITOR_TYPES.has(monitorType) ? 'issue' : 'down'
}

/**
 * `impacted_checks[].type` values that are soft issues whatever the monitor's
 * own type says.
 *
 * Classifying by monitor type alone cannot describe a `server` monitor, which
 * has two unrelated failure modes: a CPU/RAM/disk threshold breach, where the
 * agent pushed and the box is merely busy, and the agent going silent, where
 * the box may be gone. Both open an incident on the same monitor of the same
 * type. Before this, both paged as "down".
 */
const ISSUE_CHECK_TYPES = new Set(['server_metrics'])

/**
 * The severity an incident represents, preferring what the incident says
 * about itself over what its monitor's type implies.
 *
 * Falls back to the type when `impacted_checks` is absent or unreadable,
 * which keeps every incident opened before this existed classified exactly as
 * it was. Malformed JSON falls back rather than throwing: mis-routing an
 * alert is bad, dropping it is worse.
 */
export function incidentSeverity(monitorType: string, impactedChecks?: string | null): IncidentSeverity {
  try {
    const first = JSON.parse(impactedChecks || '[]')[0]
    if (first && typeof first.type === 'string' && ISSUE_CHECK_TYPES.has(first.type))
      return 'issue'
  }
  catch {
    // fall through to the type-based answer
  }

  return incidentSeverityForType(monitorType)
}

/**
 * A channel's fires-on preference, defaulting to 'both' for anything absent or
 * invalid - so a pre-column attachment (null) keeps its old fire-on-everything
 * behavior.
 */
export function normalizeFiresOn(value: unknown): FiresOn {
  return value === 'down' || value === 'issue' ? value : 'both'
}

/** Whether a channel with the given fires-on preference should fire for this severity. */
export function channelFiresFor(firesOn: unknown, severity: IncidentSeverity): boolean {
  const pref = normalizeFiresOn(firesOn)
  return pref === 'both' || pref === severity
}
