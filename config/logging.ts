import type { LoggingConfig } from '@stacksjs/types'
import { bughqTransport } from '@bughq/stacks'
import { loghqTransport } from '@loghq/stacks'
import { env } from '@stacksjs/env'
import { storagePath } from '@stacksjs/path'

/**
 * **Logging Configuration**
 *
 * This configuration defines all of your logging options. Because Stacks is fully-typed, you
 * may hover any of the options below and the definitions will be provided. In case you
 * have any questions, feel free to reach out via Discord or GitHub Discussions.
 */
export default {
  /**
   * **Log File Path**
   *
   * The path to the log file. This will be used to write logs to a file. If you do not want to
   * write logs to a file, you may set this to `null`.
   *
   * @default 'storage/logs/stacks.log'
   */
  logsPath: storagePath('logs/stacks.log'),

  /**
   * **Deployments Path**
   *
   * The path to the deployments folder. This will be used to write deployment logs to a file.
   * If you do not want to write deployment logs to a file, you may set this to `null`.
   *
   * @default 'storage/logs/deployments.log'
   */
  deploymentsPath: storagePath('logs/deployments.log'),

  /**
   * **Transports**
   *
   * Destinations for log records, alongside the console and the log file. The
   * framework calls each one for every `log.*` call, so nothing here changes a
   * single call site.
   *
   * loghq is declared unconditionally. With no `LOGHQ_KEY` the client disables
   * itself ("no ingest key, client disabled") and logging behaves exactly as it
   * did before, so this is safe in local dev and in CI without any env setup.
   *
   * Correlation is already live and costs nothing: the router stamps an
   * `x-request-id` (or a fresh uuid) into request storage, and the framework's
   * `getLogContext()` puts it on every record as `trace_id`. So any `log.*`
   * call made inside a request arrives at loghq already joinable, queryable
   * there via `GET /api/projects/{id}/logs?trace=…`.
   *
   * `captureStruct` forwards the framework's own `log.struct` events —
   * `http.request`, `db.query`, `job.*`, `cache.*`. Nothing in this app emits
   * those yet, so today it is a forward-looking hook rather than a live
   * feature. It is on because the cost is zero until something does emit.
   *
   * `channel` is what separates this app's stream from the other four in loghq.
   */
  transports: [
    loghqTransport({
      key: env.LOGHQ_KEY,
      host: env.LOGHQ_HOST || undefined,
      environment: env.APP_ENV,
      channel: 'status',
      captureStruct: true,
    }),

    // The other half of the pair, and a different job: loghq takes the whole
    // stream, bughq takes only what failed. Records at error and above become
    // bughq ISSUES; everything below is retained as a breadcrumb and attached
    // to the next issue, so the lines leading up to a failure travel with it.
    //
    // capture.unhandled stays false by default: the built server entry installs
    // its own process handlers and a second set would double-report. Queue
    // workers install none, so a worker entry has to opt in.
    bughqTransport({
      key: env.BUGHQ_KEY,
      host: env.BUGHQ_HOST || undefined,
      environment: env.APP_ENV,
    }),
  ],
} satisfies LoggingConfig
