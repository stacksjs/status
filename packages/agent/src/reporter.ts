import type { HostMetrics } from './metrics'
import { collect } from './metrics'

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
  /** Called when a push fails; defaults to a console.warn. */
  onError?: (error: Error) => void
}

export interface Reporter {
  /** Push one sample immediately. Resolves false when the push failed. */
  send: () => Promise<boolean>
  stop: () => void
}

export function metricsEndpoint(url: string, token: string): string {
  return `${url.replace(/\/+$/, '')}/api/agent/${token}/metrics`
}

async function push(endpoint: string, metrics: HostMetrics): Promise<boolean> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(metrics),
    signal: AbortSignal.timeout(10_000),
  })
  return response.ok
}

/**
 * Start reporting. Returns a handle; call `stop()` on shutdown.
 *
 * The timer is unref'd where the runtime supports it, so a reporter never
 * keeps a process alive on its own — a CLI that finishes its work should
 * exit, not linger because monitoring is running.
 */
export function startReporter(options: ReporterOptions): Reporter {
  const endpoint = metricsEndpoint(options.url, options.token)
  const onError = options.onError ?? ((error: Error) => console.warn(`[statushq] metrics push failed: ${error.message}`))

  const send = async (): Promise<boolean> => {
    try {
      return await push(endpoint, await collect({ mount: options.mount }))
    }
    catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)))
      return false
    }
  }

  const timer = setInterval(() => { void send() }, options.intervalMs ?? 60_000)
  ;(timer as { unref?: () => void }).unref?.()

  void send()

  return { send, stop: () => clearInterval(timer) }
}
