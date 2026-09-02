import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * One agent push: a CPU/memory(/disk) reading from one host on one Server.
 *
 * Its own table, not check_results rows tagged region='agent'. A sample is
 * not a check: it has no status code, no response time, and must never vote
 * in uptime.ts / consensusStatus — it used to, when samples were check_results
 * rows tagged region='agent' and a healthy CPU reading could out-vote a
 * failing probe. Keeping samples out of check_results makes every present and
 * future reader of that table correct without a region predicate.
 *
 * Minimal shape (no uuid, no API): this is the highest-volume table after
 * check_results — one row per host per minute — and nothing addresses a
 * sample individually. Pruned by PruneOldServerMetricSamples.
 */
export default defineModel({
  name: 'ServerMetricSample',
  table: 'server_metric_samples',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useTimestamps: true,
  },

  belongsTo: ['Server'],

  attributes: {
    // Normalised machine label (see app/lib/agentHosts.ts normalizeHost);
    // 'default' when the agent sent none.
    host: {
      order: 1,
      fillable: true,
      required: true,
      default: 'default',
      validation: {
        rule: schema.string().required().max(64),
      },
      factory: () => 'default',
    },

    cpuPercent: {
      order: 2,
      fillable: true,
      required: true,
      validation: {
        rule: schema.number().min(0).max(100),
      },
      factory: faker => faker.number.float({ min: 0, max: 100 }),
    },

    ramPercent: {
      order: 3,
      fillable: true,
      required: true,
      validation: {
        rule: schema.number().min(0).max(100),
      },
      factory: faker => faker.number.float({ min: 0, max: 100 }),
    },

    ramUsedMb: {
      order: 4,
      fillable: true,
      required: true,
      validation: {
        rule: schema.number().min(0),
      },
      factory: faker => faker.number.int({ min: 512, max: 32768 }),
    },

    ramTotalMb: {
      order: 5,
      fillable: true,
      required: true,
      validation: {
        rule: schema.number().min(0),
      },
      factory: () => 32768,
    },

    // Null when the agent did not report disk; disk alerting is skipped then.
    diskPercent: {
      order: 6,
      fillable: true,
      validation: {
        rule: schema.number().min(0).max(100),
      },
      factory: () => null,
    },

    // JSON array of the human-readable breach strings evaluated at ingest
    // time (evaluateBreaches), persisted so the fleet verdict can be
    // recomputed from stored rows without re-applying thresholds that may
    // since have been edited. Same convention as CheckResult.metadata.
    breaches: {
      order: 7,
      fillable: true,
      default: '[]',
      validation: {
        rule: schema.string(),
      },
      factory: () => JSON.stringify([]),
    },

    sampledAt: {
      order: 8,
      fillable: true,
      required: true,
      validation: {
        rule: schema.string().required(),
      },
      factory: faker => faker.date.recent().toISOString(),
    },
  },
} as const)
