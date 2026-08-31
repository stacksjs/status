import { verifyAttached } from '@loghq/stacks'
import { env } from '@stacksjs/env'
import { log } from '@stacksjs/logging'

/**
 * Report, once at boot, whether this app's logs are actually reaching loghq.
 *
 * Declaring the transport in `config/logging.ts` proves nothing. Three states
 * are indistinguishable from the outside and only one of them works:
 *
 *   - the logger never picked the transport up (wrong framework version)
 *   - it picked it up and the client is disabled, because `LOGHQ_KEY` was empty
 *     when the config was evaluated — which is what a key that never reached
 *     the box looks like, and what this app looked like for weeks
 *   - it is attached and delivering
 *
 * `verifyAttached()` is the only thing that separates them: it asks the logger
 * which transports it holds, then asks that transport's client whether it will
 * send.
 *
 * **This never throws.** A boot assertion that can take the app down over
 * telemetry is a worse bug than the one it detects — the first version of the
 * check underneath this reported a healthy app as unattached, and had it thrown
 * it would have crashed every app that adopted it. Logging is a dependency of
 * diagnosis, not of serving traffic.
 *
 * **And it stays quiet unless something is actually wrong.** This runs from the
 * preloader, so it runs on every CLI invocation too — `lint`, `test`, a stray
 * `buddy` command. An unconfigured key is the normal, documented state in local
 * dev and in CI (`config/logging.ts` promises exactly that), so outside
 * production it is not news and is logged at debug. A key that is missing *in
 * production* is the failure this exists to catch, and only there is it an
 * error.
 */
export async function reportLoghqAttachment(): Promise<void> {
  try {
    const isProduction = String(env.APP_ENV ?? '') === 'production'
    const info = await verifyAttached()
    const where = `seam=${info.seam}${info.via ? ` via=${info.via}` : ''}`

    // No transport at all is a misconfiguration in any environment: the config
    // declares one, so the framework failing to take it means the seam is not
    // there. Worth saying wherever it happens.
    if (info.seam === 'none') {
      log.error(`loghq: declared but not attached (${where}). Logs are staying local — check that @stacksjs/logging is a version with transport support.`)
      return
    }

    if (!info.live) {
      const why = info.disabledReason ?? 'disabled in config'
      const detail = `loghq: attached but not delivering — ${why} (${where}).`

      if (info.disabledReason === 'auth' && !isProduction) {
        // The documented local default: no key, client disables itself, logs
        // carry on to the console and the file. Not a problem, and not worth a
        // red line on every lint run.
        log.debug(`${detail} Expected without LOGHQ_KEY outside production.`)
        return
      }

      log.error(`${detail}${info.disabledReason === 'auth' ? ' LOGHQ_KEY is missing or rejected; on a deployed box that usually means the key never reached the environment.' : ''}`)
      return
    }

    // `introspected: false` means the transport came from another copy of the
    // package, so `live` is assumed rather than measured. Worth recording — a
    // duplicate install is also how a transport silently stops working.
    const certainty = info.introspected ? '' : ' (liveness assumed: transport built by another copy of @loghq/stacks)'
    log.debug(`loghq: attached and delivering (${where})${certainty}`)
  }
  catch (err) {
    log.debug(`loghq: could not determine attachment: ${err instanceof Error ? err.message : String(err)}`)
  }
}
