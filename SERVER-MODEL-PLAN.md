# Server model — plan

Status: design settled, implementation spec in progress. This document is the source of truth for the
decisions already made; the spec sections below it will be filled in as they are finalised.

## Why

Today every monitor that has an agent installed carries its own copy of the server's identity: the
agent token lives on the monitor (`monitors.metrics_token`), the cpu/ram/disk thresholds live in that
monitor's `config` JSON, host samples land in `check_results` keyed to the monitor, and a hot box raises
one incident per monitor that happens to point at it. Six sites on one machine means six tokens, six
threshold sets that can disagree about what "too hot" means, and six incidents for one CPU.

The fix is a parent model. One physical machine gets one identity, and monitors attach to it.

## Decisions

**Name: `Server`.** Not `Host` — `host` already means two things in this codebase (the agent's free-text
machine label in `agentHosts.ts`, and the hostname returned by `siteHost()`), and a model would make a
third. Not `Box` — jargon that reads wrong in UI and docs. `Server` is what the product already says
("run this on the server you want to watch") and what existing monitors are literally named.

**Ownership split.**

| Server | Monitor |
|---|---|
| agent token | url, check type, interval |
| cpu / ram / disk thresholds, metrics window | assertions, expected status |
| host metric samples and history | up/down status, uptime % |
| the "box is hot" and "agent went quiet" incidents | the "site is down" incident |
| its own state: `healthy` / `hot` / `quiet` | `status` as today |

**`monitors.server_id` is nullable, one server per monitor.** A monitor with no server keeps working
exactly as today. This is a `belongsTo`, not a pivot: channels are many-to-many so they get
`monitor_notification_channels`, but a site sits on exactly one machine.

**`reports_metrics` goes away.** "Does this monitor report metrics" becomes "is `server_id` set". That
also removes the case where turning metrics off left a live ingest credential on the monitor, because
the token no longer lives on the monitor at all.

**Hostname matching is a suggestion, never membership.** Two production agents send no hostname at all
(the label arrives as `default`), including the one on StatusHQ's own box, so it cannot be relied on.

## UI

Mirrors the existing Alert routing card and its stated rule (`resources/views/dashboard/monitors/[id].stx`):
the card shows the answer, the dialog holds the form.

- A **Server card** on the monitor page. Attached: server name, CPU/memory/disk against thresholds,
  last-sample age, how many other monitors share the box, and a "Manage server" button. Detached: a
  neutral dashed empty state — deliberately not the red `.is-danger` variant used for "0 of 0 channels",
  because a monitor with no server is normal (nobody runs an agent on a third-party API) and red would
  nag on every external monitor forever. When a hostname matches an existing server, the empty state
  carries the suggestion.
- The dialog offers **attach to existing** and **create new** side by side, the latter prefilled from the
  monitor's hostname. A single-site box is a server with one monitor; there is no separate concept.
- Both directions exist: the server page multi-selects its monitors, the monitor page attaches one server.
- A threshold breach is an **issue, not a down**. `MonitorNotificationChannel.firesOn` already
  distinguishes `down` / `issue` / `both`, so a server incident routes as `issue` with no new alerting
  concept. It renders in amber, never in the red reserved for a site being down.
- The breach renders in **one place**: a band on the server page, with the "N monitors on this server"
  list beneath it showing each monitor's own up/down. On attached monitors it appears only as the amber
  reading inside the Server card, never as its own banner.
- Config (thresholds, attachment) lives in dialogs. The server itself is a page with a URL, because it
  owns metric history, incidents, and a monitor list.

## What production looks like (read-only inspection, 2026-09-02)

- The agent token is a real column, `monitors.metrics_token`, generated as a dashless UUIDv7.
  Thresholds are `config` JSON keys (`cpuThreshold`, `ramThreshold`, `diskThreshold`) set on two monitors;
  the rest use defaults.
- Eight monitors are flagged `reports_metrics`; only four have ever received an agent sample. The other
  four were issued a token and never had an agent installed. Three of those four are sites on StatusHQ's
  own shared box.
- Two of the four live agents send no hostname (`default`) and are different machines. **The backfill
  must group by token, never by host label.**
- Agent samples (`region = 'agent'`) are ~47% of all `check_results` rows — the largest region.
- Incidents, all time (read-only, 2026-09-02):

  | kind | total | open |
  |---|---|---|
  | host threshold breached | 2,001 | 45 |
  | multi-region consensus | 1,327 | 0 |
  | response-time regression | 264 | 4 |
  | agent went quiet | 11 | 5 |
  | DNS, SSL, ports, crawl | ~230 | 9 |

  Breach incidents are 52% of every incident ever raised. The 5 open "agent went quiet" incidents are the four
  never-installed tokens plus one monitor whose flag is off but whose token still exists; nothing can ever
  resolve them today. Both groups are resolved by the migration.
- The deployed agent reads its token from an env file on a 60-second timer. **If the token value is carried
  over unchanged, no agent needs touching.**

## Existing bug this fixes by construction

Right now production has 45 open "host threshold breached" incidents across a handful of boxes, and one
monitor alone holds five of them. Cause, in
`app/Actions/Agents/ReceiveMetricsAction.ts` around line 159: the incident opens and resolves on edges of
`monitors.status`, but the monitor's own HTTP/health check also writes that column. The check flips the
monitor back to `up` without passing through the ingest action's resolve branch, so the next agent push
sees `up → degraded` and opens another incident. Recovery also resolves only the newest open incident.

With `Server` carrying its own state column written only by the ingest path and `CheckStaleMetrics`, the
server incident keys off that column and there is no second writer. At most one open incident per server;
changing breaches update it in place. The migration resolves the currently stacked incidents.

## Backfill rules

1. One `Server` per distinct `metrics_token` that has at least one agent sample. Token carried over verbatim.
2. Thresholds copied from the monitor's `config` onto the server; defaults where absent.
3. Monitors with a token and no samples get no server. Their `server_id` stays null and the orphan token is
   dropped. The ones on the shared box should be attached to that box's server by hand.
4. Every open incident carrying the `server_metrics` marker — the 45 breach incidents and the 5 perpetual
   quiet-agent ones, which share that marker — is resolved as part of the migration, with an incident update
   saying why.

## Pending

- **Where host samples live** — stay in `check_results` re-keyed to `server_id`, or a dedicated table. Being
  decided by an adversarial review; the answer decides whether the agent-region voting bug in the uptime
  calculation is fixed by construction or needs its own guard.
- The full spec: `Server.ts`, the migration chain, ingest and threshold changes, test plan, ship order.

## Open question

When a box is hot but every site on it is up, should the **public** status page show anything? Default
assumption: no — public status reflects what users experience, and a warm CPU is not an outage. Changes if
the status page doubles as an ops dashboard.
