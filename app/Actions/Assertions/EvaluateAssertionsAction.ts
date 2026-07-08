import type { AssertionSubject } from '../../lib/assertionEval'
import { Action } from '@stacksjs/actions'
import { describeAssertion, evaluateAssertion } from '../../lib/assertionEval'
import Assertion from '../../Models/Assertion'

export type { AssertionSubject } from '../../lib/assertionEval'

export interface AssertionEvaluation {
  passed: boolean
  /** Human-readable failure messages, one per failed assertion — empty when passed is true. */
  failures: string[]
  /** How many assertions the monitor has (0 means the caller can fall back to its default status logic). */
  count: number
}

/**
 * Evaluates every Assertion attached to a monitor against one check's
 * response (stacksjs/status#1 Phase 12). Called by RunUptimeCheck/
 * RunHealthCheck after a successful HTTP response — a monitor with zero
 * assertions always passes (the existing plain up/down-by-status-code
 * behavior is unaffected). ALL assertions must pass for `passed: true`. The
 * per-assertion evaluation lives in app/lib/assertionEval.ts (pure, unit-
 * tested); this action only loads the rules and aggregates the result.
 */
export default new Action({
  name: 'EvaluateAssertionsAction',
  description: 'Evaluate a monitor\'s assertions against a check response',

  async handle(payload: { monitorId: number, subject: AssertionSubject }): Promise<AssertionEvaluation> {
    const assertions = await Assertion.where('monitor_id', payload.monitorId).orderBy('sort_order', 'asc').get()
    if (assertions.length === 0)
      return { passed: true, failures: [], count: 0 }

    const failures: string[] = []
    for (const assertion of assertions) {
      if (!evaluateAssertion(assertion, payload.subject))
        failures.push(`Assertion failed: ${describeAssertion(assertion)}`)
    }

    return { passed: failures.length === 0, failures, count: assertions.length }
  },
})
