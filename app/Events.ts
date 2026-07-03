import type { Events } from '@stacksjs/types'

/**
 * **Events Configuration**
 *
 * This configuration defines all of your events. Because Stacks is fully-typed, you may
 * hover any of the options below and the definitions will be provided. In case you
 * have any questions, feel free to reach out via Discord or GitHub Discussions.
 */
export default {
  // eventName: ['Listener1', 'Listener2'] -> listeners default to ./app/actions/*
  'user:registered': ['SendWelcomeEmail'],
  'user:created': ['NotifyUser'],

  // Incident has `observe: true` (see app/Models/Incident.ts), which emits
  // these automatically on every create/update (stacksjs/status#1 Phase 6).
  'incident:created': ['Notifications/SendIncidentNotification'],
  'incident:updated': ['Notifications/SendIncidentResolvedNotification'],

  // CheckResult has `observe: ['create']` (see app/Models/CheckResult.ts) —
  // the outbound webhook event stream (stacksjs/status#1 Phase 10). Event
  // name is the model name lowercased with no separator (see
  // define-model.ts: `definition.name.toLowerCase()`), NOT snake_case —
  // 'checkresult:created', not 'check_result:created'.
  'checkresult:created': ['Webhooks/DeliverCheckResultWebhooks'],
} satisfies Events
