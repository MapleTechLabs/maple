import type { EdgeCacheServiceApi } from "@maple/cache"
import { WarehouseAuthError, WarehouseConfigError } from "@maple/domain/http"
import { Cause, Effect, Option, Predicate, Schema, Array as Arr } from "effect"
import { summarizeCause } from "@maple/backend/platform/describe-cause"

/**
 * Per-org quarantine for the cross-org alerting ticks (errors / anomalies /
 * digests). An org whose warehouse rejects queries with an auth/config-class
 * error (e.g. a Tinybird token whose workspace no longer exists) fails
 * identically on every tick — retrying each 1–5 min only burns quota and floods
 * the error dashboards. When a tick's per-org failure carries such an error,
 * the org is parked in the edge cache and skipped until the TTL expires, which
 * doubles as the automatic retry once the org's config is repaired.
 *
 * Scoped to warehouse-connectivity errors only: transient upstream failures
 * (`WarehouseUpstreamError`) and genuine query bugs keep retrying every tick.
 */

const QUARANTINE_BUCKET = "warehouse-org-quarantine"
const QUARANTINE_TTL_S = 6 * 60 * 60

type EdgeCache = EdgeCacheServiceApi

/**
 * Errors that indicate the org's warehouse is unusable until an operator fixes
 * its configuration — not until the next retry.
 */
const isAuthError = Schema.is(WarehouseAuthError)
const isConfigError = Schema.is(WarehouseConfigError)

const hasQuarantineTag = (value: unknown, depth = 0): boolean => {
	if (depth > 8 || typeof value !== "object" || value === null) return false
	if (isAuthError(value) || isConfigError(value)) return true
	// Services wrap warehouse failures in their own tagged errors (e.g.
	// AnomalyPersistenceError) with the original error as `cause`: walk it.
	return Predicate.hasProperty(value, "cause") && hasQuarantineTag(value.cause, depth + 1)
}

/** Does this cause (or anything wrapped inside it) carry an auth/config-class warehouse error? */
export const causeHasWarehouseConfigClassError = <E>(cause: Cause.Cause<E>): boolean =>
	Arr.some(cause.reasons, (reason) =>
		Cause.isFailReason(reason)
			? hasQuarantineTag(reason.error)
			: Cause.isDieReason(reason) && hasQuarantineTag(reason.defect),
	)

/** Best-effort check — a cache failure never blocks the tick, it just disables the skip. */
export const isOrgWarehouseQuarantined = (edgeCache: EdgeCache, orgId: string) =>
	edgeCache.rawGet<number>(QUARANTINE_BUCKET, orgId).pipe(
		Effect.map(Option.isSome),
		Effect.orElseSucceed(() => false),
	)

/** Park the org for `QUARANTINE_TTL_S`. Best-effort; failures are ignored. */
export const quarantineOrgWarehouse = (edgeCache: EdgeCache, orgId: string, nowMs: number) =>
	edgeCache.rawPut(QUARANTINE_BUCKET, orgId, nowMs, QUARANTINE_TTL_S).pipe(Effect.ignore)

/**
 * Shared per-org failure seam for the alerting ticks: when the failure is
 * config-class, quarantine the org and log at Info (expected, parked); anything
 * else is logged at Error as before. Returns whether the org was quarantined.
 */
export const quarantineOnConfigClassCause = <E>(
	edgeCache: EdgeCache,
	orgId: string,
	cause: Cause.Cause<E>,
	nowMs: number,
) =>
	causeHasWarehouseConfigClassError(cause)
		? quarantineOrgWarehouse(edgeCache, orgId, nowMs).pipe(Effect.as(true))
		: Effect.succeed(false)

export interface WarehouseOrgTurn<A> {
	/** The org's result when it is parked and skipped. */
	readonly skipped: A
	/** The org's result after a failure, once the failure is logged or the org parked. */
	readonly failed: Effect.Effect<A>
	/** Error-level line for a failure that is not config-class. */
	readonly failureMessage: string
	/** Info-level line for a skipped org; omitted, the skip is silent. */
	readonly skipMessage?: string
	/** Whether parking the org logs at Info. Defaults to true. */
	readonly logQuarantine?: boolean
}

/**
 * One org's turn in a cross-org tick: a parked org is skipped, and a failure parks the org when it
 * is config-class or is logged at Error otherwise, so one bad org cannot fail the tick. Interrupts
 * (isolate teardown) still propagate, so the tick cancels instead of marching on.
 */
export const runWarehouseOrgTurn = <A, E, R>(
	edgeCache: EdgeCache,
	orgId: string,
	nowMs: number,
	body: Effect.Effect<A, E, R>,
	turn: WarehouseOrgTurn<A>,
): Effect.Effect<A, never, R> =>
	Effect.gen(function* () {
		if (yield* isOrgWarehouseQuarantined(edgeCache, orgId)) {
			if (turn.skipMessage !== undefined)
				yield* Effect.logInfo(turn.skipMessage).pipe(Effect.annotateLogs({ orgId }))
			return turn.skipped
		}
		return yield* body
	}).pipe(
		Effect.catchCause((cause) =>
			Cause.hasInterruptsOnly(cause)
				? Effect.interrupt
				: Effect.gen(function* () {
						const quarantined = yield* quarantineOnConfigClassCause(
							edgeCache,
							orgId,
							cause,
							nowMs,
						)
						if (!quarantined) {
							yield* Effect.logError(turn.failureMessage).pipe(
								Effect.annotateLogs({ orgId, error: summarizeCause(cause) }),
							)
						} else if (turn.logQuarantine !== false) {
							yield* Effect.logInfo(
								"Org warehouse rejected queries with a config-class error; quarantined",
							).pipe(Effect.annotateLogs({ orgId, error: summarizeCause(cause) }))
						}
						return yield* turn.failed
					}),
		),
	)
