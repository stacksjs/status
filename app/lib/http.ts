import type { ResponseStatus } from '@stacksjs/bun-router'

/**
 * 402 Payment Required — what a plan limit actually means, and what the
 * billing tests assert on.
 *
 * @stacksjs/bun-router's `ResponseStatus` union
 * (dist/types.d.ts: 200 | 201 | 202 | 204 | 301 | 302 | 304 | 400 | 401 |
 * 403 | 404 | 405 | 409 | 422 | 429 | 500 | 502 | 503 | 504) omits it, so
 * passing the literal is a type error even though the status is correct and
 * has always been sent. The cast lives here once rather than at each call
 * site; delete it if upstream widens the union.
 */
export const PAYMENT_REQUIRED = 402 as unknown as ResponseStatus
