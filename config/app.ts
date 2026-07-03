import type { AppConfig } from '@stacksjs/types'
import { env } from '@stacksjs/env'

/**
 * **Application Configuration**
 *
 * This configuration defines all of your application options. Because Stacks is fully-typed,
 * you may hover any of the options below and the definitions will be provided. In case
 * you have any questions, feel free to reach out via Discord or GitHub Discussions.
 */
export default {
  name: env.APP_NAME ?? 'UptimeStatus',
  description: 'UptimeStatus is an open, self-hostable monitoring platform for uptime, SSL, DNS, cron, and status pages.',
  env: env.APP_ENV ?? 'local',
  url: env.APP_URL ?? 'status.localhost',
  redirectUrls: [],
  debug: env.DEBUG ?? false,
  key: env.APP_KEY,

  maintenanceMode: env.APP_MAINTENANCE ?? false,
  comingSoonMode: env.APP_COMING_SOON ?? false,
  comingSoonSecret: env.APP_COMING_SOON_SECRET ?? '',
  // docMode: true, // instead of example.com/docs, deploys example.com as main entry point for docs
  docMode: false,

  timezone: 'America/Los_Angeles',
  locale: 'en',
  fallbackLocale: 'en',
  cipher: 'aes-256-cbc',
} satisfies AppConfig
