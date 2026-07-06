# Adding a second check region (US-East / Ashburn) — ops runbook

This is the step-by-step procedure to bring up a real second checking region
on the **shared Redis + networked-Postgres** model. It is the operational
companion to [multi-region-and-scaling.md](./multi-region-and-scaling.md),
which explains *why* the pieces below exist.

The application code that makes this possible already ships:

- Every view reads through the dialect-agnostic query builder, so the app
  runs unchanged on Postgres (not just the local SQLite file).
- `config/regions.ts` + `app/Jobs/EvaluateMonitorConsensus.ts` decide a
  monitor's status from **cross-region agreement**, so a second region
  reduces false alerts instead of doubling them.
- `config/cloud.ts` has a `worker` deploy role that provisions a
  checks-only box.

What remains is infrastructure you run once. Budget a short maintenance
window for the SQLite → Postgres cutover (step 4).

---

## Topology after this runbook

```
  Falkenstein (EU) — PRIMARY                     Ashburn (US) — WORKER
  ┌────────────────────────────┐                 ┌─────────────────────┐
  │ web + API + worker          │                 │ checks worker only  │
  │ scheduler (dispatch +       │                 │ WORKER_REGION=us-east│
  │   EvaluateMonitorConsensus) │                 └─────────┬───────────┘
  │ Postgres  ◄─────────────────┼── WireGuard tunnel ───────┤
  │ Redis     ◄─────────────────┼───────────────────────────┘
  └────────────────────────────┘
```

- Only the **primary** runs the scheduler, migrations, web, and consensus.
- The **worker** only pulls `checks`-queue jobs and writes region-tagged
  `CheckResult` rows to the shared Postgres over the tunnel.
- Hetzner private networks are location-scoped (they do **not** span
  US↔EU), so Postgres/Redis are reached over a **WireGuard** tunnel, never
  the public internet.

---

## Step 0 — Prerequisites

- `HCLOUD_TOKEN` set (Hetzner Cloud API token) for `./buddy deploy`.
- The primary is already deployed and healthy at `uptime-status.org`.
- Decide the two region labels: `eu-central` (primary) and `us-east` (new).

## Step 1 — Stand up Postgres + Redis on the primary, behind WireGuard

On the **primary** box:

1. **Postgres + Redis are provisioned by pantry.** `config/deps.ts` is
   env-driven: when `DB_CONNECTION=postgres` (and `QUEUE_DRIVER=redis`) it adds
   `postgresql.org` + `redis.io` to the dependency set and autostarts them as
   pantry services, then runs `./buddy migrate` on activation. So the deploy
   installs and starts them for you — no manual `apt install`. (The Stacks
   schema is verified to build cleanly on Postgres: all migrations apply with
   `SERIAL` primary keys and table-qualified enum types — see the
   `bun-query-builder` Postgres fixes.)
2. **WireGuard** between the two boxes. `wg`/`wg-quick` come from the OS
   (`apt install wireguard-tools`; the data plane is the in-kernel module,
   mainline since Linux 5.6) — there's also a `wireguard.com` pantry recipe if
   you prefer the pantry-native tools. Bind Postgres and Redis to the
   **WireGuard interface address only** (`listen_addresses` / `bind` = the
   `wg0` IP + `127.0.0.1`), never `0.0.0.0`, and add a firewall rule allowing
   the peer's WireGuard IP to reach `5432`/`6379`.
3. Note the primary's WireGuard IP — that is the `DB_HOST` / `REDIS_URL`
   host the worker will use.

> Why not a managed DB? Hetzner has no managed Postgres, and a managed
> provider would still need to be reachable cross-region. Self-hosting on
> the primary behind WireGuard keeps data private and costs nothing extra.
> Alternatively, skip WireGuard entirely and expose Postgres/Redis over TLS
> with a Hetzner firewall allowlisting only the Ashburn box's static IP — same
> privacy, one less moving part.

## Step 2 — Point the primary at Postgres + Redis (still single-region)

Update the primary's `.env.production` and redeploy:

```dotenv
DB_CONNECTION=postgres
DB_HOST=<primary-wireguard-ip>
DB_PORT=5432
DB_DATABASE=uptime_status
DB_USERNAME=uptime
DB_PASSWORD=<secret>

QUEUE_DRIVER=redis
REDIS_URL=redis://<primary-wireguard-ip>:6379

# still single-region until the worker is up:
MONITOR_REGIONS=eu-central
WORKER_REGION=eu-central
```

`./buddy deploy` runs `buddy migrate`, which builds the schema on Postgres.
Do **not** put real traffic through it yet — this is where step 4's data
copy happens.

## Step 3 — Provision the Ashburn checks worker

```bash
STATUS_DEPLOY_ROLE=worker \
HCLOUD_LOCATION=ash \
WORKER_REGION=us-east \
./buddy deploy
```

This provisions a cheap box (a `cpx11`/`cx22` is plenty for a checks
worker) whose only service is `bun buddy queue:work --queue=checks` (see the
`worker` branch of `config/cloud.ts`). Give it the same
`DB_*` + `REDIS_URL` (pointing at the primary's WireGuard IP) and
`WORKER_REGION=us-east` in its environment. It must **not** get
`MONITOR_REGIONS` or a scheduler — only the primary evaluates consensus.

## Step 4 — Migrate existing SQLite data → Postgres (maintenance window)

1. Stop the primary's `worker` + `scheduler` services (pause new writes).
2. Copy existing rows from `stacks.sqlite` into Postgres. `buddy migrate`
   has already created the tables; this step is a data copy only (e.g.
   `pgloader sqlite:///path/to/stacks.sqlite postgresql://…`, or a
   table-by-table dump/load). Verify row counts match for the high-value
   tables: `monitors`, `check_results`, `incidents`, `status_pages`,
   `team_members`, `subscriptions`.
3. Restart the primary services.

## Step 5 — Turn on two-region consensus

On the **primary**, set both regions and redeploy:

```dotenv
MONITOR_REGIONS=eu-central,us-east
# CONSENSUS_MIN_REGIONS=2            # default; both regions must agree to alert
# CONSENSUS_FRESHNESS_SECONDS=600    # default
```

Consensus is backward compatible: until `us-east` results actually arrive,
the effective threshold clamps to the regions that reported, so nothing
breaks during rollout.

## Step 6 — Verify

- `CheckResult.region` now carries **both** `eu-central` and `us-east`:
  ```sql
  SELECT region, COUNT(*) FROM check_results
  WHERE checked_at > now() - interval '10 minutes' GROUP BY region;
  ```
- **Consensus behaves:** temporarily block one region's egress to a single
  target (or point a throwaway monitor at an IP only one region can't
  reach). A **single-region** failure must NOT open an incident; a
  **both-region** failure must. This is the whole point of the exercise.
- `buddy queue:status` on the primary shows the `checks` queue draining with
  both workers consuming.
- The dashboard + public status pages render identically to before (they now
  read Postgres through the same query builder; the 90-day uptime bars are
  memory-cached on the primary with a 60s TTL).

---

## Rollback

Every step is reversible. To fall back to the single EU box: set
`MONITOR_REGIONS=eu-central`, `QUEUE_DRIVER=database`,
`DB_CONNECTION=sqlite` on the primary and redeploy, then destroy the Ashburn
box. (You'd lose any writes made to Postgres after the cutover, so snapshot
first.)

## Cost note

The second region is a proportional increase in outbound check traffic
against every monitored target — one extra HTTP/ping/TCP request per check
interval per monitor. Start with two regions; only add a third once you have
a concrete reason, because every region multiplies that egress again.
