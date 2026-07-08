import { describe, expect, test } from 'bun:test'
import HeartbeatMonitor from '../../app/Models/HeartbeatMonitor'
import MaintenanceWindow from '../../app/Models/MaintenanceWindow'

// The auto-CRUD store/update handlers validate a request against the model's
// attribute rules (customValidate -> 422), so asserting the rule itself is
// asserting exactly what the API enforces at create/update time. Model.create()
// is deliberately not gated - the fail-safe cron evaluation is the backstop
// there (see app/lib/heartbeat.ts / app/lib/maintenance.ts).

function cronRule(model: any, attr: string): any {
  return model.attributes?.[attr]?.validation?.rule
}

function isValid(rule: any, value: string): boolean {
  return rule.validate(value).valid === true
}

describe('Cron field validation on create/update (stacksjs/status#1)', () => {
  const cases: Array<[string, string]> = [
    ['HeartbeatMonitor', 'cronExpression'],
    ['MaintenanceWindow', 'recurrenceCron'],
  ]
  const models: Record<string, any> = { HeartbeatMonitor, MaintenanceWindow }

  for (const [modelName, attr] of cases) {
    describe(`${modelName}.${attr}`, () => {
      const rule = cronRule(models[modelName], attr)

      test('the rule is present and runnable', () => {
        expect(rule).toBeTruthy()
        expect(typeof rule.validate).toBe('function')
      })

      test('accepts valid cron expressions and nicknames', () => {
        expect(isValid(rule, '0 2 * * *')).toBe(true)
        expect(isValid(rule, '0 2 * * 0')).toBe(true)
        expect(isValid(rule, '*/15 * * * *')).toBe(true)
        expect(isValid(rule, '@daily')).toBe(true)
        expect(isValid(rule, '@hourly')).toBe(true)
      })

      test('rejects malformed cron expressions', () => {
        expect(isValid(rule, 'not a cron')).toBe(false)
        expect(isValid(rule, '99 * * * *')).toBe(false) // minute out of range
        expect(isValid(rule, '* * *')).toBe(false) // too few fields
      })

      test('a malformed value carries a helpful message', () => {
        const result = rule.validate('nonsense')
        expect(result.valid).toBe(false)
        expect(result.errors[0]?.message).toContain('valid cron expression')
      })

      test('an empty or absent value is allowed (the field is optional)', () => {
        expect(isValid(rule, '')).toBe(true)
      })

      test('still enforces the max length', () => {
        expect(isValid(rule, `@daily${' '.repeat(200)}`)).toBe(false)
      })
    })
  }
})
