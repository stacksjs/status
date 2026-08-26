---
title: Server Metrics
description: Push CPU, memory, and disk telemetry from your servers with a small cron collector and chart host health alongside your uptime checks.
---

# Server Metrics

Server metrics bring host-level telemetry — CPU, memory and disk — into the same place as your uptime and performance checks. Unlike every other monitor, it's **push-based**: your server sends metrics to StatusHQ, so it works for private servers with no inbound access.

## How it works

A small collector runs on each server. On an interval it samples the host and **pushes** a metrics payload to your ingest endpoint. It is a ~70-line POSIX shell script, not a binary, so you can read exactly what it collects before you run it — and any cron job that can POST JSON works just as well. Tracked signals:

- **CPU** utilisation (overall, `cpuPercent`)
- **Memory** utilisation (`ramPercent`) plus used / total in MB (`ramUsedMb` / `ramTotalMb`)
- **Disk** utilisation (`diskPercent`, optional - the supplied collector reports the root filesystem, or whatever `--mount` you pass it)

Because it's push, there's nothing to expose publicly - the collector dials out to StatusHQ. Every sample is recorded as a check result, so it charts per host and feeds the same history and uptime machinery as any other monitor. A push is a JSON POST to `/api/agent/<metrics-token>/metrics` (the token appears on the monitor page once you enable metrics):

```bash
curl -fsS -X POST https://statushq.org/api/agent/<metrics-token>/metrics \
  -H "Content-Type: application/json" \
  -d '{"host":"web-01","cpuPercent":37.2,"ramPercent":38.4,"ramUsedMb":6112,"ramTotalMb":16384,"diskPercent":68}'
```

The collector does this for you on a schedule; the raw call is shown so you understand the shape. `cpuPercent`, `ramPercent`, `ramUsedMb`, and `ramTotalMb` are required (percentages 0-100); `diskPercent` and `host` are optional.

## Several machines, one monitor

`host` is what makes a fleet legible. Send it and each machine is its own series, listed on the monitor's **Hosts** card with its own CPU, memory, disk and last-sample time; omit it and every collector is one anonymous series, which is what a single-server monitor wants.

The monitor's status is then the fleet's, not the last sample's: it is **degraded while any host is breaching**, and recovers only when the breaching host itself recovers. Degraded rather than down, because the sample only exists because the agent pushed it — the box is reachable, it is busy. A breach therefore does not cost uptime and does not page your down-only channels; a host that stops pushing entirely does both. A healthy push from a second machine cannot clear the first machine's alert — without that rule, two nodes taking turns would flap the monitor up and down once a minute. Incidents name the host that breached, so the page you are woken up to says which box to open a shell on.

A host whose samples stop is not held against the monitor forever — after the missed-push window its last reading is ignored, and silence is caught by the window rule below instead. Hostnames are lowercased and trimmed to 64 characters, so `Web-01` and `web-01` are one machine.

The SDKs send `host` automatically ([`@statushq/agent`](https://github.com/stacksjs/status/tree/main/packages/agent) for Bun/Node, [`statushq/laravel-sdk`](https://github.com/bughq/statushq-laravel) for PHP), as does the installer's collector.

## What triggers an alert

- A metric crosses its **threshold**. Each push is evaluated against the monitor's thresholds - defaults are CPU `>= 90%`, memory `>= 90%`, and disk `>= 85%` (disk only when the collector reports it). A breach marks the host degraded and opens an [incident](/operate/incidents), which fans out to the monitor's [notification channels](/operate/notifications) as an **issue** rather than an outage; the next healthy push resolves it. Set any threshold to `0` to disable that metric.
- **No metrics received** within the expected window (the collector stopped or the host is down) - a missed push works like a heartbeat. The window defaults to 300 seconds and is checked every minute.

Thresholds and the missed-push window live in the monitor's config (`cpuThreshold`, `ramThreshold`, `diskThreshold`, `metricsWindowSeconds`).

## Setting it up

1. **Create or open a monitor** in the dashboard. Server metrics are not a monitor *type* — they are a toggle, so any monitor can also report host telemetry (an uptime check on the site the box serves is the usual pairing).
2. Tick **This host pushes CPU, memory and disk samples** and save. That issues the host's ingest token and reveals the **Agent setup** card.
3. Copy the command from that card and run it on the server, as root:

```bash
curl -fsSL https://statushq.org/install-agent.sh | sudo sh -s -- --token=<YOUR-TOKEN>
```

That is the whole install. It writes the collector to `/usr/local/bin/statushq-agent`, stores the token in `/etc/statushq-agent.env` (mode `0600`), schedules it with a systemd timer — falling back to `/etc/cron.d` where systemd is absent — and then **sends one sample immediately** so a bad token or a blocked egress surfaces while you are still at the terminal, instead of as a mysterious missed-push incident five minutes later.

4. Attach **notifications** so a breach reaches you.

### Installer options

| Flag | Default | Purpose |
|---|---|---|
| `--token=<TOKEN>` | — | Required. The ingest token from the monitor's page. |
| `--url=<URL>` | `https://statushq.org` | Your origin. Self-hosted installs pass their own. |
| `--interval=<SEC>` | `60` | Seconds between samples. Keep it **below** the monitor's missed-push window (`metricsWindowSeconds`, default 300) or the monitor alerts between pushes. Cron installs are fixed at one minute. |
| `--mount=<PATH>` | `/` | Which filesystem `diskPercent` reports on. |
| `--uninstall` | — | Removes the collector, token file, timer and cron entry. |

Re-running the installer is safe and is also how you **upgrade the collector or rotate the token** — it overwrites both.

### Checking it works

```bash
systemctl list-timers statushq-agent.timer   # when it next fires
journalctl -u statushq-agent.service -f      # what happened on the last runs
/usr/local/bin/statushq-agent                # run one sample by hand
```

The collector exits non-zero if the push is rejected, so a failing agent shows up as a failed systemd unit rather than a silent no-op.

### Requirements

Linux, with `curl` and `awk` present. It reads `/proc/stat` and `/proc/meminfo` and shells out to `df`. CPU is measured as the busy-jiffy delta across a one-second window rather than a single instantaneous sample, and memory used is `MemTotal - MemAvailable`, which matches what `free` reports as used.

### Rolling your own

The installer is a convenience, not a requirement — anything that POSTs the payload on a schedule works. If you write your own collector, note that the endpoint returns **422** for a percentage outside 0–100 and **404** for an unknown token, so use `curl -f` or you will not notice either.

## Related

- [Cron & Heartbeats](/monitors/cron-heartbeats) · [Performance](/monitors/performance) · [Port Scan](/monitors/port-scan)
- [Notifications](/operate/notifications)
- Marketing: [Server metrics feature](https://statushq.org/features/server-metrics)
