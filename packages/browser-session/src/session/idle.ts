/**
 * Rotate the session after this much inactivity (PostHog's default). The visit
 * claim uses the same window: longer and a rotated session goes unbilled,
 * shorter and one continuous visit is billed twice.
 */
export const IDLE_TIMEOUT_MS = 30 * 60_000
