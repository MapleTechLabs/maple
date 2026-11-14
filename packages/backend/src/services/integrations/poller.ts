// Building blocks every integration poller shares: the leased row a tick claims, the hold a failed
// tick leaves, the pause check, the source health report, and how a failure is classified.
// Each poller still owns its own shape (call budgets, frontiers, fan-out); these keep the plumbing one.

import type { MapleDb } from "@maple/db/client"
import type { SourceId } from "@maple/primitives"
import * as PG from "@maple-dev/effect-orm/postgres"
import { Effect, Option, Ref, String as Str } from "effect"
import { isSourcePaused, type PollOutcome, reportPoll } from "./integration-sources"
import { leaseClaimable } from "./lease"

const MINUTE_MS = 60_000

/** Why one poll failed. The classification decides both the hold and what the source reports. */
export type PollFailure =
	/** The credential or grant was refused: nothing can be read until it is reconnected. */
	| { readonly _tag: "Rejected"; readonly reason: string }
	/** The vendor asked us to slow down. */
	| { readonly _tag: "RateLimited"; readonly message: string; readonly retryAfterMs?: number | undefined }
	/** The ingest gateway refused the org (billing, a revoked key): retrying soon cannot succeed. */
	| { readonly _tag: "IngestRefused"; readonly message: string }
	/** Anything else: the vendor or Maple failed this once. */
	| { readonly _tag: "Upstream"; readonly message: string }

/**
 * One table for every poller: how long a failure holds the row, and what its source reports.
 * `keep` leaves the source's last report, so a failure that lasts reads stale rather than failing.
 */
export const POLL_FAILURE_POLICY = {
	Rejected: { holdMs: 0, report: "disconnected" },
	RateLimited: { holdMs: 15 * MINUTE_MS, report: "keep" },
	IngestRefused: { holdMs: 60 * MINUTE_MS, report: "failed" },
	Upstream: { holdMs: 0, report: "failed" },
} as const satisfies Record<
	PollFailure["_tag"],
	{ readonly holdMs: number; readonly report: "disconnected" | "failed" | "keep" }
>

/** The longest hold any failure sets; a hold further ahead than twice this is a corrupt value. */
export const MAX_POLL_HOLD_MS = 60 * MINUTE_MS

export const pollFailureMessage = (failure: PollFailure) =>
	failure._tag === "Rejected" ? failure.reason : failure.message

/** When the row may be claimed again after `failure`, or null when it is not held. */
export const pollFailureHoldUntil = (failure: PollFailure, now: number): number | null => {
	const base = POLL_FAILURE_POLICY[failure._tag].holdMs
	// A longer Retry-After is honoured, up to the longest hold.
	const asked = failure._tag === "RateLimited" ? (failure.retryAfterMs ?? 0) : 0
	const holdMs = Math.min(MAX_POLL_HOLD_MS, Math.max(base, asked))
	return holdMs === 0 ? null : now + holdMs
}

/** What the source records for `failure`; null leaves its last report. */
export const pollFailureOutcome = (
	failure: PollFailure,
	resources?: Extract<PollOutcome, { _tag: "Ok" }>["resources"],
): PollOutcome | null => {
	switch (POLL_FAILURE_POLICY[failure._tag].report) {
		case "disconnected":
			return { _tag: "Disconnected", reason: pollFailureMessage(failure) }
		case "failed":
			return { _tag: "Failed", error: Str.slice(0, 500)(pollFailureMessage(failure)), resources }
		case "keep":
			return null
	}
}

/**
 * Free to claim: no live lease (a lease further than twice `leaseMs` ahead is a clock jump or a
 * crashed writer), and no hold, or one past or corrupt. One bound for every poller.
 */
export const leaseFree = <P>(
	leaseUntil: PG.Expr<number | null, P>,
	holdUntil: PG.Expr<number | null, P>,
	now: number,
	leaseMs: number,
) =>
	PG.and(
		leaseClaimable(leaseUntil, now, 2 * leaseMs),
		PG.or(holdUntil.isNull(), holdUntil.lte(now), holdUntil.gt(now + 2 * MAX_POLL_HOLD_MS)),
	)

export interface LeaseSpec<Row, Set, E> {
	/** How long a claim holds the row; a tick must finish inside it. */
	readonly leaseMs: number
	/** One conditional `UPDATE ... RETURNING` that writes `leaseUntil` where {@link leaseFree} holds. */
	readonly claim: (leaseUntil: number, now: number) => Effect.Effect<Row | null, E>
	/** One write on the claimed row, compare-and-set on what the claim wrote; false once it is not ours. */
	readonly write: (claimed: Row, set: Set) => Effect.Effect<boolean, E>
	/** The write that ends the tick: the lease cleared, the hold set (null clears it). */
	readonly release: (holdUntil: number | null, now: number) => Set
	/** How the release is written; defaults to `write`. Railway releases on the lease alone. */
	readonly releaseWrite?: (claimed: Row, set: Set) => Effect.Effect<boolean, E>
}

export interface Lease<Row, Set, E> {
	readonly row: Row
	readonly now: number
	/** A compare-and-set write on the claimed row; false once a successor holds it. */
	readonly write: (set: Set) => Effect.Effect<boolean, E>
	/** Holds the row past this tick until `untilMs`; the longest hold asked for wins. */
	readonly hold: (untilMs: number | null) => Effect.Effect<void>
	/** Holds the row as long as {@link POLL_FAILURE_POLICY} says for `failure`. */
	readonly holdFor: (failure: PollFailure) => Effect.Effect<void>
}

/**
 * Claims the row, runs `body` under the lease and releases it in `ensuring`, with the hold the body
 * asked for. None when another tick holds the row, or a hold has not run out.
 */
export const withLease = <Row, Set, E, A, E2, R>(
	spec: LeaseSpec<Row, Set, E>,
	now: number,
	body: (lease: Lease<Row, Set, E>) => Effect.Effect<A, E2, R>,
): Effect.Effect<Option.Option<A>, E | E2, R> =>
	Effect.flatMap(spec.claim(now + spec.leaseMs, now), (row) => {
		if (row === null) return Effect.succeedNone
		return Effect.flatMap(Ref.make<number | null>(null), (holdRef) => {
			const hold = (untilMs: number | null) =>
				untilMs === null
					? Effect.void
					: Ref.update(holdRef, (current) =>
							current === null ? untilMs : Math.max(current, untilMs),
						)
			const lease: Lease<Row, Set, E> = {
				row,
				now,
				write: (set) => spec.write(row, set),
				hold,
				holdFor: (failure) => hold(pollFailureHoldUntil(failure, now)),
			}
			return body(lease).pipe(
				Effect.asSome,
				Effect.ensuring(
					Ref.get(holdRef).pipe(
						Effect.flatMap((holdUntil) =>
							(spec.releaseWrite ?? spec.write)(row, spec.release(holdUntil, now)),
						),
						Effect.ignore({ log: "Warn" }),
					),
				),
			)
		})
	})

type DbRunError = Effect.Error<ReturnType<MapleDb["run"]>>

/** Runs a service's Postgres access for a result `A`; `makeDbExecute`'s result fits. */
export type DbRun<A, E> = (fn: (db: MapleDb) => Effect.Effect<A, DbRunError>) => Effect.Effect<A, E>

/**
 * Runs `body` unless the source is paused, else `onPaused`: a paused source reads nothing the
 * gateway would drop. A row not linked to a source yet is never paused.
 */
export const skipIfPaused =
	<E, B, E3, R3>(
		run: DbRun<boolean, E>,
		sourceId: SourceId | null,
		now: number,
		onPaused: Effect.Effect<B, E3, R3>,
	) =>
	<A, E2, R>(body: Effect.Effect<A, E2, R>): Effect.Effect<A | B, E | E2 | E3, R | R3> =>
		Effect.flatMap(
			run((db) => isSourcePaused(db, sourceId, now)),
			(paused): Effect.Effect<A | B, E2 | E3, R | R3> => (paused ? onPaused : body),
		)

/**
 * Records a tick on its source. Best effort: a failed report is logged, never fails the tick it
 * describes. A null outcome leaves the last report.
 */
export const makeSourceReporter =
	<E>(run: DbRun<void, E>, label: string) =>
	(sourceId: SourceId | null, outcome: PollOutcome | null, now: number): Effect.Effect<void> =>
		outcome === null
			? Effect.void
			: run((db) => reportPoll(db, sourceId, outcome, now)).pipe(
					Effect.catch((error) =>
						Effect.logWarning(`${label} source health report failed`).pipe(
							Effect.annotateLogs({ sourceId, error }),
						),
					),
				)
