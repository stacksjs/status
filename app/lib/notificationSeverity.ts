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
