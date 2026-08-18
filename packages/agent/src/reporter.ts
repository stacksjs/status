import type { FileReader, HostSample } from './metrics'
import { createCollector, isReportable, toIngestPayload } from './metrics'

/**
 * The push side: report host metrics to StatusHQ on an interval.
 *
 * Push is what a pull endpoint cannot do — it works on a box with no inbound
 * HTTP, behind NAT, and it keeps reporting while the web app itself is down.
 * Each host carries its own token, so three nodes behind a load balancer are
 * three distinct series rather than whichever one happened to answer.
 */

export interface ReporterOptions {
  /** StatusHQ base URL, e.g. https://statushq.org */
  url: string
  /** The monitor's metrics token (Agent setup card on the monitor page). */
  token: string
  intervalMs?: number
  mount?: string
  /** Overrides the hostname reported with each sample. */
  host?: string
  files?: FileReader
  /** Called when a push fails; defaults to a console.warn. */
  onError?: (error: Error) => void
}

export interface Reporter {
  /** Push one sample immediately. Resolves false when nothing was sent. */
  send: () => Promise<boolean>
  stop: () => void
}

export function metricsEndpoint(url: string, token: string): string {
  return `${url.replace(/\/+$/, '')}/api/agent/${encodeURIComponent(token)}/metrics`
}

async function push(endpoint: string, sample: HostSample): Promise<boolean> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(toIngestPayload(sample)),
    signal: AbortSignal.timeout(10_000),
  })
  return response.ok
}

/**
 * Start reporting. Returns a handle; call `stop()` on shutdown.
 *
 * The first tick sends nothing on purpose. CPU usage is a rate and needs two
 * counter readings to exist; a number derived from one reading is the box's
 * average since boot, which on a machine that has been idle all week and is
 * pinned right now reads as roughly zero — indistinguishable from a genuinely
 * idle box, so nobody would ever catch that it was invented.
 *
 * The timer is unref'd where the runtime supports it, so a reporter never
 * keeps a process alive on its own — a CLI that finishes its work should
 * exit, not linger because monitoring is running.
 */
export function startReporter(options: ReporterOptions): Reporter {
  const endpoint = metricsEndpoint(options.url, options.token)
  const onError = options.onError ?? ((error: Error) => console.warn(`[statushq] metrics push failed: ${error.message}`))
  const collector = createCollector({ mount: options.mount, files: options.files, host: options.host })

  const send = async (): Promise<boolean> => {
    try {
      const sample = collector.collect()
      if (!isReportable(sample))
        return false

      return await push(endpoint, sample)
    }
    catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)))
      return false
    }
  }

  const timer = setInterval(() => { void send() }, options.intervalMs ?? 60_000)
  ;(timer as { unref?: () => void }).unref?.()

  // Establishes the CPU baseline rather than reporting; the tick after this
  // one is the first with a rate to send.
  void send()

  return { send, stop: () => clearInterval(timer) }
}
