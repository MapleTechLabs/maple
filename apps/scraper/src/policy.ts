import { Duration } from "effect"
import type { ScrapeFailureReason } from "./ScrapeError"

/** Upper bound on exponential backoff so a target keeps probing for recovery. */
export const MAX_BACKOFF = Duration.minutes(5)
/**
 * Flat park for a billing block (gateway 402). Scraping again cannot clear it,
 * only a subscription change can, so probe hourly instead of climbing the ladder.
 */
export const DELIVERY_BLOCKED_BACKOFF = Duration.minutes(60)

/** What the policy needs from a failed scrape. `ScrapeError` satisfies it. */
export interface FailureSignal {
	readonly reason: ScrapeFailureReason
	readonly retryAfterMs: number | null
}

/** Reason for a non-2xx answer from a scrape target. */
export const classifyTargetStatus = (status: number): ScrapeFailureReason => {
	if (status === 429 || status === 503) return "rate_limited"
	if (status === 401 || status === 403) return "auth_failed"
	if (status >= 500) return "target_error"
	return "scrape_failed"
}

/** Every reason except `scrape_failed` escalates the delay instead of holding cadence. */
export const shouldBackOff = (failure: FailureSignal | null): boolean =>
	failure !== null && failure.reason !== "scrape_failed"

/**
 * Delay before a target's next scrape. Healthy and `scrape_failed` scrapes hold
 * `baseMs` (the loop subtracts elapsed time to stay start-to-start). Backoff
 * reasons double per consecutive backoff, honor a longer `Retry-After`, and cap
 * at {@link MAX_BACKOFF}; a billing block parks flat for {@link DELIVERY_BLOCKED_BACKOFF}.
 */
export const nextScrapeDelayMs = ({
	baseMs,
	failure,
	consecutiveBackoffs,
}: {
	readonly baseMs: number
	readonly failure: FailureSignal | null
	readonly consecutiveBackoffs: number
}): number => {
	if (failure === null || !shouldBackOff(failure)) return baseMs
	const retryAfterMs = failure.retryAfterMs ?? 0
	if (failure.reason === "delivery_blocked") {
		return Math.max(Duration.toMillis(DELIVERY_BLOCKED_BACKOFF), retryAfterMs)
	}
	const exponential = baseMs * 2 ** consecutiveBackoffs
	return Math.min(Duration.toMillis(MAX_BACKOFF), Math.max(exponential, retryAfterMs))
}

/** The log line for a backing-off scrape, one per reason. */
export const backoffLogMessage = (reason: ScrapeFailureReason): string => {
	switch (reason) {
		case "rate_limited":
			return "Scrape rate-limited, backing off"
		case "auth_failed":
			return "Scrape auth rejected, backing off"
		case "delivery_blocked":
			return "Scrape delivery blocked by the ingest gateway, backing off"
		case "target_error":
			return "Scrape target returning server errors, backing off"
		case "scrape_failed":
			return "Scrape failed, backing off"
	}
}

/**
 * Deterministic start offset in `[0, baseMs)` from a stable key (FNV-1a). Spreads
 * targets that share an interval across it, so a restart or a discovered
 * target's branches don't scrape on the same tick and trip upstream rate limits.
 */
export const startJitterMs = (key: string, baseMs: number): number => {
	if (baseMs <= 0) return 0
	let hash = 0x811c9dc5
	for (let i = 0; i < key.length; i++) {
		hash ^= key.charCodeAt(i)
		hash = Math.imul(hash, 0x01000193)
	}
	return (hash >>> 0) % baseMs
}
