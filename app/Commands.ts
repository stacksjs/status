export interface CommandConfig {
  /** The command file name (without .ts extension) */
  file: string
  /** Whether the command is enabled */
  enabled?: boolean
  /** Command aliases */
  aliases?: string[]
}

export type CommandRegistry = Record<string, string | CommandConfig>

/**
 * The application's command registry.
 *
 * Commands listed here will be auto-loaded by the CLI.
 * You can use a simple string (file name) or a config object for more control.
 *
 * @example
 * // Simple registration
 * 'inspire': 'Inspire',
 *
 * // With config
 * 'send-emails': {
 *   file: 'SendEmails',
 *   enabled: true,
 *   aliases: ['emails', 'mail'],
 * },
 */
export default {
  'inspire': 'Inspire',
  // Live-status broadcaster (stacksjs/status#1 Phase 8 follow-up) — hosts
  // the WebSocket server and pushes monitor status changes to the
  // dashboard. See app/Commands/Realtime.ts.
  'realtime': 'Realtime',
  // Reconcile the Hetzner probe fleet to config/probes.ts (provision declared,
  // decommission removed). See app/Commands/DeployProbes.ts.
  'deploy:probes': 'DeployProbes',
} satisfies CommandRegistry
