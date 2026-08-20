import { Action } from '@stacksjs/actions'

/**
 * An Action whose `handle` receives a dispatched payload rather than an HTTP request.
 *
 * `Action`'s `handle` is typed as `(request: RequestInstance) => ...`, which is
 * right for a routed action. Actions registered in app/Events.ts are invoked by
 * the event dispatcher with a plain object instead, so every one of them was a
 * type error against a request type it never receives.
 *
 * This was previously fixed by adding a `TInput` type parameter to
 * `ActionOptions` in the vendored framework (96e18c4). Adding a type parameter
 * to an existing generic cannot be done through declaration merging, so with
 * the framework on npm the fix has to live here until it is upstreamed.
 *
 * The cast is contained to this one function on purpose: the runtime object is
 * exactly what `new Action(...)` always received, only the declared parameter
 * type differs, so nothing is being loosened beyond the known gap.
 */
export function eventAction<TPayload>(options: {
  name: string
  description?: string
  handle: (payload: TPayload) => unknown | Promise<unknown>
}): InstanceType<typeof Action> {
  return new Action(options as never) as InstanceType<typeof Action>
}
