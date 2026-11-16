import { Effect, Result, Schema, type Tracer } from "effect"
import { ScrapeTargetId } from "@maple/domain/http"

/**
 * Why a scrape failed. Retry policy, the span's `error.type` and the backoff
 * log line all derive from this one field (see `policy.ts`).
 *
 * - `rate_limited`: the target answered 429/503.
 * - `auth_failed`: the target rejected its credential (401/403).
 * - `target_error`: the target answered another 5xx, was unreachable, or timed out.
 * - `target_rejected`: the target answered another 4xx (404 for a moved or deleted endpoint).
 * - `delivery_blocked`: our ingest gateway refused the export with 402 (org over its billing limit).
 * - `scrape_failed`: anything else; the only reason that holds the configured cadence
 *   and the only one that closes a span as an error (see `isExpectedFailure`).
 */
export const ScrapeFailureReason = Schema.Literals([
	"rate_limited",
	"auth_failed",
	"delivery_blocked",
	"target_error",
	"target_rejected",
	"scrape_failed",
])
export type ScrapeFailureReason = typeof ScrapeFailureReason.Type

/**
 * The scraper's one failure type. Clients classify at the source: the code that
 * saw the response sets `reason`, so the scheduler never inspects HTTP statuses.
 */
export class ScrapeError extends Schema.TaggedError<ScrapeError>()("@maple/scraper/ScrapeError", {
	message: Schema.String,
	reason: ScrapeFailureReason,
	statusCode: Schema.NullOr(Schema.Number),
	retryAfterMs: Schema.NullOr(Schema.Number),
	// Set once the failure is attributed to a target, so the error issue names it.
	targetId: Schema.optionalKey(ScrapeTargetId),
	targetName: Schema.optionalKey(Schema.String),
	targetHost: Schema.optionalKey(Schema.String),
}) {}

export const scrapeError = (fields: {
	readonly message: string
	readonly reason: ScrapeFailureReason
	readonly statusCode?: number | null
	readonly retryAfterMs?: number | null
}): ScrapeError =>
	new ScrapeError({
		message: fields.message,
		reason: fields.reason,
		statusCode: fields.statusCode ?? null,
		retryAfterMs: fields.retryAfterMs ?? null,
	})

/**
 * Whether the failure is the target's or the org's side rather than ours: the target
 * down, rejecting its credential or path, rate limiting, or a billing block. The org
 * sees these on its target's health; only `scrape_failed` is a fault Maple can fix.
 */
export const isExpectedFailure = (reason: ScrapeFailureReason): boolean => reason !== "scrape_failed"

const annotateFailure = (error: ScrapeError) =>
	Effect.annotateCurrentSpan({
		"error.type": error.reason,
		...(error.statusCode !== null ? { "http.response.status_code": error.statusCode } : undefined),
	})

/**
 * `Effect.withSpan` with the scraper's span-status rule in one place: every
 * failure annotates `error.type`, but an expected one is re-raised outside the
 * span so it closes `Ok` instead of opening an error issue for a customer's target.
 */
export const withScrapeSpan =
	(name: string, options?: Tracer.SpanOptionsNoTrace) =>
	<A, R>(self: Effect.Effect<A, ScrapeError, R>): Effect.Effect<A, ScrapeError, R> =>
		self.pipe(
			Effect.map((value): Result.Result<A, ScrapeError> => Result.succeed(value)),
			Effect.tapError(annotateFailure),
			Effect.catchIf(
				(error) => isExpectedFailure(error.reason),
				(error) => Effect.succeed(Result.fail(error)),
			),
			Effect.withSpan(name, options),
			Effect.flatMap(Effect.fromResult),
		)
