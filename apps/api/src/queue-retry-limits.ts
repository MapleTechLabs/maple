/**
 * Retry limits a queue consumer's settings and its batch handler must agree on: Cloudflare stops
 * redelivering after `maxRetries` without saying so, and the handler logs the drop on that attempt.
 * Dependency-free, so `worker/consumers.ts` reads them without loading a runtime module.
 */
export const AUDIT_EVENTS_MAX_RETRIES = 5

export const CANCELLATION_REVIEW_MAX_RETRIES = 5
