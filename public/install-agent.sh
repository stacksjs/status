#!/bin/sh
# StatusHQ server-metrics agent installer.
#
#   curl -fsSL https://statushq.org/install-agent.sh | sudo sh -s -- --token=<TOKEN>
#
# Installs a small POSIX-sh collector that samples CPU, memory and disk once a
# minute and POSTs them to your monitor's ingest endpoint, plus a systemd timer
# (or a cron entry where systemd is absent) to run it. Re-running is safe: it
# overwrites the collector and rewrites the credentials, so it doubles as the
# upgrade and re-key path. `--uninstall` removes everything it created.
#
# Deliberately POSIX sh, not bash: cron runs /bin/sh, which is dash on Debian
# and Ubuntu, and the snippet this replaces used bash process substitution
# (`read A B < <(free -m ...)`) that dash cannot parse — so pasting it into a
# crontab failed with a syntax error and the host silently never reported.
set -eu

DEFAULT_URL="https://statushq.org"
BIN_PATH="/usr/local/bin/statushq-agent"
ENV_PATH="/etc/statushq-agent.env"
SERVICE_PATH="/etc/systemd/system/statushq-agent.service"
TIMER_PATH="/etc/systemd/system/statushq-agent.timer"
CRON_PATH="/etc/cron.d/statushq-agent"

URL=""
TOKEN=""
INTERVAL=60
MOUNT="/"
ACTION="install"

usage() {
  cat <<'USAGE'
StatusHQ metrics agent installer

Usage:
  install-agent.sh --token=<TOKEN> [options]
  install-agent.sh --uninstall

Options:
  --token=<TOKEN>     Ingest token from the monitor's page (required to install)
  --url=<URL>         StatusHQ base URL (default https://statushq.org).
                      Self-hosted installs pass their own origin.
  --interval=<SEC>    Seconds between samples (default 60). Keep this below the
                      monitor's missed-push window (metricsWindowSeconds,
                      default 300) or the monitor alerts between pushes.
  --mount=<PATH>      Filesystem to report disk usage for (default /)
  --uninstall         Remove the collector, credentials, timer and cron entry
  -h, --help          Show this message
USAGE
}

fail() {
  echo "install-agent: $*" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --token=*) TOKEN="${1#*=}" ;;
    --url=*) URL="${1#*=}" ;;
    --interval=*) INTERVAL="${1#*=}" ;;
    --mount=*) MOUNT="${1#*=}" ;;
    --uninstall) ACTION="uninstall" ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) fail "unknown option '$1' (try --help)" ;;
  esac
  shift
done

[ "$(id -u)" = "0" ] || fail "must run as root — pipe to 'sudo sh' rather than 'sh'"

if [ "$ACTION" = "uninstall" ]; then
  if command -v systemctl >/dev/null 2>&1; then
    systemctl disable --now statushq-agent.timer >/dev/null 2>&1 || true
  fi
  rm -f "$BIN_PATH" "$ENV_PATH" "$SERVICE_PATH" "$TIMER_PATH" "$CRON_PATH"
  if command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload >/dev/null 2>&1 || true
  fi
  echo "StatusHQ agent removed."
  exit 0
fi

[ -n "$TOKEN" ] || fail "--token is required (copy it from the monitor's page)"
[ -z "$URL" ] && URL="$DEFAULT_URL"
URL="${URL%/}"

case "$INTERVAL" in
  '' | *[!0-9]*) fail "--interval must be a whole number of seconds" ;;
esac
[ "$INTERVAL" -ge 10 ] || fail "--interval must be at least 10 seconds"

[ -r /proc/stat ] || fail "/proc/stat is unreadable — this collector needs a Linux host"
[ -r /proc/meminfo ] || fail "/proc/meminfo is unreadable — this collector needs a Linux host"
command -v curl >/dev/null 2>&1 || fail "curl is required but not installed"
command -v awk >/dev/null 2>&1 || fail "awk is required but not installed"

# --- the collector -----------------------------------------------------------
# Quoted heredoc: nothing here is expanded at install time, so the script on
# disk reads exactly as written and the token stays out of it (it lives in the
# 0600 env file instead, rather than in a world-readable /usr/local/bin script).
cat > "$BIN_PATH" <<'COLLECTOR'
#!/bin/sh
# StatusHQ metrics collector — installed by https://statushq.org/install-agent.sh
set -eu

[ -r /etc/statushq-agent.env ] || { echo "statushq-agent: missing /etc/statushq-agent.env" >&2; exit 1; }
. /etc/statushq-agent.env

: "${STATUSHQ_URL:?statushq-agent: STATUSHQ_URL unset}"
: "${STATUSHQ_TOKEN:?statushq-agent: STATUSHQ_TOKEN unset}"
DISK_MOUNT="${STATUSHQ_MOUNT:-/}"

# CPU busy share across a 1s window. A single `top -bn1` sample reports an
# instantaneous slice — and catches the collector's own startup spike — so it
# swings between 0 and 100 run to run. Delta the jiffies instead.
cpu_sample() {
  read -r _label user nice sys idle iowait irq softirq steal _rest < /proc/stat
  echo "$((user + nice + sys + idle + iowait + irq + softirq + steal)) $((idle + iowait))"
}

set -- $(cpu_sample)
busy_before="$1" idle_before="$2"
sleep 1
set -- $(cpu_sample)
busy_after="$1" idle_after="$2"

total_delta=$((busy_after - busy_before))
idle_delta=$((idle_after - idle_before))
if [ "$total_delta" -gt 0 ]; then
  CPU=$(((100 * (total_delta - idle_delta)) / total_delta))
else
  CPU=0
fi

# MemAvailable is the kernel's own estimate of what a new workload could claim;
# it accounts for reclaimable page cache, so total-minus-available matches what
# `free` calls "used" far better than total-minus-free does. Fall back for
# kernels older than 3.14, which do not publish it.
MEM_TOTAL_KB=$(awk '/^MemTotal:/ {print $2; exit}' /proc/meminfo)
MEM_AVAIL_KB=$(awk '/^MemAvailable:/ {print $2; exit}' /proc/meminfo)
if [ -z "${MEM_AVAIL_KB:-}" ]; then
  MEM_AVAIL_KB=$(awk '/^MemFree:|^Buffers:|^Cached:/ {sum += $2} END {print sum + 0}' /proc/meminfo)
fi

RAM_TOTAL_MB=$((MEM_TOTAL_KB / 1024))
RAM_AVAIL_MB=$((MEM_AVAIL_KB / 1024))
RAM_USED_MB=$((RAM_TOTAL_MB - RAM_AVAIL_MB))
[ "$RAM_USED_MB" -lt 0 ] && RAM_USED_MB=0
if [ "$RAM_TOTAL_MB" -gt 0 ]; then
  RAM=$((RAM_USED_MB * 100 / RAM_TOTAL_MB))
else
  RAM=0
fi

DISK=$(df -P "$DISK_MOUNT" 2>/dev/null | awk 'NR==2 {gsub(/%/, "", $5); print $5}')

# The ingest endpoint rejects anything outside 0-100 with a 422, so clamp
# rather than let a rounding artefact drop the whole sample.
clamp() {
  case "$1" in
    '' | *[!0-9]*) echo 0 ;;
    *) [ "$1" -gt 100 ] && echo 100 || echo "$1" ;;
  esac
}
CPU=$(clamp "$CPU")
RAM=$(clamp "$RAM")

# Which machine this sample came from. Without it every box sharing a token
# normalizes to a single 'default' series server-side, so a fleet shows
# whichever host reported last instead of all of them. Both SDKs send it; the
# installer must not be the odd one out. Non-alphanumerics are stripped to
# match normalizeHost() in app/lib/agentHosts.ts, and the quotes are escaped
# so an odd hostname cannot break the JSON.
HOST=$(hostname 2>/dev/null | tr -cd 'A-Za-z0-9._-' | cut -c1-64)
[ -n "$HOST" ] || HOST=default

PAYLOAD="{\"cpuPercent\":$CPU,\"ramPercent\":$RAM,\"ramUsedMb\":$RAM_USED_MB,\"ramTotalMb\":$RAM_TOTAL_MB,\"host\":\"$HOST\""
if [ -n "${DISK:-}" ]; then
  PAYLOAD="$PAYLOAD,\"diskPercent\":$(clamp "$DISK")"
fi
PAYLOAD="$PAYLOAD}"

# -f so an HTTP error is a non-zero exit the timer records, instead of a silent
# success that leaves the monitor looking healthy while nothing arrives.
curl -fsS --max-time 20 --retry 2 --retry-delay 2 \
  -X POST "$STATUSHQ_URL/api/agent/$STATUSHQ_TOKEN/metrics" \
  -H 'Content-Type: application/json' \
  -d "$PAYLOAD" > /dev/null
COLLECTOR
chmod 755 "$BIN_PATH"

# --- credentials -------------------------------------------------------------
# 0600: the token is a bearer credential for this host's ingest endpoint.
umask 077
cat > "$ENV_PATH" <<ENVFILE
# StatusHQ metrics agent — written by install-agent.sh
STATUSHQ_URL="$URL"
STATUSHQ_TOKEN="$TOKEN"
STATUSHQ_MOUNT="$MOUNT"
ENVFILE
chmod 600 "$ENV_PATH"
umask 022

# --- scheduling --------------------------------------------------------------
SCHEDULER=""
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  SCHEDULER="systemd"

  cat > "$SERVICE_PATH" <<SERVICE
[Unit]
Description=StatusHQ metrics collector
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=$BIN_PATH
SERVICE

  # OnUnitActiveSec paces from the end of the last run, so a slow push cannot
  # stack overlapping samples the way a fixed cron minute would.
  cat > "$TIMER_PATH" <<TIMER
[Unit]
Description=StatusHQ metrics collector timer

[Timer]
OnBootSec=30
OnUnitActiveSec=${INTERVAL}s
AccuracySec=5s
Unit=statushq-agent.service

[Install]
WantedBy=timers.target
TIMER

  rm -f "$CRON_PATH"
  systemctl daemon-reload
  systemctl enable --now statushq-agent.timer >/dev/null
else
  SCHEDULER="cron"
  command -v crontab >/dev/null 2>&1 || [ -d /etc/cron.d ] \
    || fail "neither systemd nor cron is available to schedule the collector"
  if [ "$INTERVAL" -ne 60 ]; then
    echo "install-agent: cron granularity is one minute; ignoring --interval=$INTERVAL" >&2
  fi
  cat > "$CRON_PATH" <<CRON
# StatusHQ metrics collector — written by install-agent.sh
* * * * * root $BIN_PATH >/dev/null 2>&1
CRON
  chmod 644 "$CRON_PATH"
fi

# --- verify ------------------------------------------------------------------
# Prove the whole path works now, while the operator is still at the terminal,
# rather than letting a bad token surface as a mysterious missed-push incident
# five minutes later.
echo "Sending a first sample..."
if "$BIN_PATH"; then
  echo
  echo "StatusHQ agent installed."
  echo "  collector:  $BIN_PATH"
  echo "  config:     $ENV_PATH (0600)"
  echo "  scheduler:  $SCHEDULER, every ${INTERVAL}s"
  echo "  endpoint:   $URL/api/agent/<token>/metrics"
  echo
  if [ "$SCHEDULER" = "systemd" ]; then
    echo "  logs:       journalctl -u statushq-agent.service -f"
    echo "  next run:   systemctl list-timers statushq-agent.timer"
  else
    echo "  cron entry: $CRON_PATH"
  fi
  echo "  uninstall:  curl -fsSL $URL/install-agent.sh | sudo sh -s -- --uninstall"
else
  echo
  echo "install-agent: the first sample failed to send." >&2
  echo "The collector and schedule are installed; fix the cause and it will" >&2
  echo "retry on the next tick. Common causes:" >&2
  echo "  - wrong or rotated --token (the endpoint answers 404)" >&2
  echo "  - metrics not enabled on the monitor yet" >&2
  echo "  - this host cannot reach $URL outbound" >&2
  echo "Run $BIN_PATH by hand to see the error." >&2
  exit 1
fi
