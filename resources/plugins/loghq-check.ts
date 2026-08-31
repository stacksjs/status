/**
 * Report once, at boot, whether this app's logs are actually reaching loghq.
 *
 * This app has no app-owned `preloader.ts` to hang the check off — its preload
 * chain ends in the vendored framework one, which must not be edited — so the
 * check gets its own entry in `bunfig.toml`, after the framework preloader.
 * `status/resources/plugins/env-preload.ts` is the precedent for an app-owned
 * preload here.
 *
 * The skip list mirrors the framework preloader's `fastCommands`, because a
 * standalone preload entry otherwise runs for *every* CLI invocation, and this
 * check awaits the logger's initialisation, which loads config. `buddy lint`
 * and `bun test` should not pay for a diagnostic they will never read.
 *
 * See `app/Support/loghq.ts` for why the check never throws and why it stays
 * silent outside production.
 */

const args = process.argv.slice(2)

// No argv[1] means a REPL or `bun -e`, which has no boot to report on.
const isRepl = !process.argv[1]

const fastCommands = [
  'dev',
  'build',
  'test',
  'lint',
  '--version',
  '-v',
  'version',
  '--help',
  '-h',
  'help',
  'migrate',
  'fresh',
  'seed',
  'generate',
  'make',
  'key:generate',
  'scaffold:crud',
]

const skip = isRepl
  || process.env.STACKS_DEV_SERVER === '1'
  || (args.length > 0 && fastCommands.some(cmd => args[0] === cmd || args[0]!.startsWith(`${cmd}:`)))

if (!skip) {
  // Not awaited: a diagnostic must not sit on the boot path, and must not be
  // able to fail the boot even if it throws.
  import('../../app/Support/loghq')
    .then(m => m.reportLoghqAttachment())
    .catch(() => {})
}
