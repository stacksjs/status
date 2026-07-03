import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * A structured check assertion (stacksjs/status#1 Phase 12, inspired by
 * openstatusHQ/openstatus's assertion DSL — re-implemented from scratch,
 * no code reuse, see the Phase 12 issue note on licensing). Replaces
 * free-form keyword matching buried in Monitor.config with a queryable,
 * composable rule: "the response's `target` (optionally narrowed by
 * `property`, e.g. a header name) must `compare` `expected`".
 *
 * A monitor can have zero assertions (plain up/down by status code, the
 * existing behavior) or several — evaluated by EvaluateAssertionsAction,
 * called from RunUptimeCheck/RunHealthCheck. ALL assertions on a monitor
 * must pass for the check to be considered 'up'.
 */
export default defineModel({
  name: 'Assertion',
  table: 'assertions',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSeeder: {
      count: 20,
    },
    useApi: {
      uri: 'assertions',
      routes: ['index', 'store', 'show', 'update', 'destroy'],
    },
  },

  belongsTo: ['Monitor'],

  attributes: {
    // What part of the response this assertion inspects.
    target: {
      order: 1,
      fillable: true,
      required: true,
      validation: {
        rule: schema.enum(['status_code', 'header', 'body', 'response_time']),
      },
      factory: faker => faker.helpers.arrayElement(['status_code', 'header', 'body', 'response_time']),
    },

    // Only meaningful when target = 'header' (the header name, e.g.
    // "content-type"). Null/unused for the other targets — status_code,
    // body, and response_time each only have one possible value to check.
    property: {
      order: 2,
      fillable: true,
      validation: {
        rule: schema.string().max(255),
      },
      factory: () => 'content-type',
    },

    compare: {
      order: 3,
      fillable: true,
      required: true,
      validation: {
        rule: schema.enum(['eq', 'not_eq', 'gt', 'gte', 'lt', 'lte', 'contains', 'not_contains', 'empty', 'not_empty']),
      },
      factory: faker => faker.helpers.arrayElement(['eq', 'contains', 'gt', 'lt']),
    },

    // The value to compare against, always stored as a string — numeric
    // comparisons (gt/gte/lt/lte) coerce it with Number() at evaluation
    // time. Unused (may be empty) for the empty/not_empty compares.
    expected: {
      order: 4,
      fillable: true,
      validation: {
        rule: schema.string().max(1000),
      },
      factory: () => '200',
    },

    // Evaluation/display order when a monitor has several assertions.
    // Named sortOrder, not order — "order" is a SQL reserved word and this
    // ORM doesn't quote identifiers in its INSERT statement (same
    // constraint that renamed DnsSnapshot.values -> recordValues earlier
    // in this project).
    sortOrder: {
      order: 5,
      fillable: true,
      default: 0,
      validation: {
        rule: schema.number(),
      },
      factory: () => 0,
    },
  },
} as const)
