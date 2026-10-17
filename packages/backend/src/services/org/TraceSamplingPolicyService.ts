import {
	DEFAULT_TRACE_SAMPLING_POLICY,
	IsoDateTimeString,
	TraceSamplingPersistenceError,
	TRACE_SAMPLE_RATIO_MAX,
	TRACE_SAMPLE_RATIO_MIN,
	TraceSamplingPolicyDocument,
	type TraceSamplingPolicyUpdateRequest,
	type OrgId,
} from "@maple/domain/http"
import * as PG from "@maple-dev/effect-orm/postgres"
import { OrgIngestSamplingPolicies, type OrgIngestSamplingPolicyRow } from "@maple/db/tables"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"

const decodeIso = Schema.decodeUnknownSync(IsoDateTimeString)

const toPersistenceError = makePersistenceErrorMapper(
	TraceSamplingPersistenceError,
	"Trace sampling policy persistence failure",
)

/** Reads a stored ratio the way the gateway applies it, so an out-of-range row stays repairable. */
const storedRatio = (ratio: number) =>
	Number.isFinite(ratio)
		? Math.min(TRACE_SAMPLE_RATIO_MAX, Math.max(TRACE_SAMPLE_RATIO_MIN, ratio))
		: TRACE_SAMPLE_RATIO_MAX

const storedSlowSpansMs = (ms: number | null) => (ms === null || ms <= 0 ? null : ms)

const toDocument = (row: Option.Option<OrgIngestSamplingPolicyRow>) =>
	Option.match(row, {
		onNone: () => new TraceSamplingPolicyDocument({ ...DEFAULT_TRACE_SAMPLING_POLICY, updatedAt: null }),
		onSome: (r) =>
			new TraceSamplingPolicyDocument({
				traceSampleRatio: storedRatio(r.traceSampleRatio),
				alwaysKeepErrorSpans: r.alwaysKeepErrorSpans,
				alwaysKeepSlowSpansMs: storedSlowSpansMs(r.alwaysKeepSlowSpansMs),
				updatedAt: decodeIso(new Date(r.updatedAt).toISOString()),
			}),
	})

/** The columns a PATCH writes: only the fields it names, plus the timestamp. */
interface SamplingPolicyChange {
	traceSampleRatio?: number
	alwaysKeepErrorSpans?: boolean
	alwaysKeepSlowSpansMs?: number | null
	updatedAt: number
}

export interface TraceSamplingPolicyUpdate {
	readonly before: TraceSamplingPolicyDocument
	readonly after: TraceSamplingPolicyDocument
}

export interface TraceSamplingPolicyServiceApi {
	/** The stored policy, or the gateway's defaults when the org has none. */
	readonly get: (orgId: OrgId) => Effect.Effect<TraceSamplingPolicyDocument, TraceSamplingPersistenceError>
	/** Merges the request into the current policy and stores it; omitted fields keep their value. */
	readonly update: (
		orgId: OrgId,
		request: TraceSamplingPolicyUpdateRequest,
	) => Effect.Effect<TraceSamplingPolicyUpdate, TraceSamplingPersistenceError>
}

export class TraceSamplingPolicyService extends Context.Service<
	TraceSamplingPolicyService,
	TraceSamplingPolicyServiceApi
>()("@maple/api/services/TraceSamplingPolicyService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const dbExecute = makeDbExecute(database, "TraceSamplingPolicyService", toPersistenceError)

		const selectRow = (orgId: OrgId) =>
			PG.from(OrgIngestSamplingPolicies)
				.select()
				.where(($) => [$.orgId.eq(orgId)])
				.limit(1)

		const loadRow = (orgId: OrgId) =>
			dbExecute((db) => db.run(selectRow(orgId))).pipe(
				Effect.map((rows) => Option.fromUndefinedOr(rows[0])),
			)

		const get = Effect.fn("TraceSamplingPolicyService.get")(function* (orgId: OrgId) {
			yield* Effect.annotateCurrentSpan({ orgId })
			return toDocument(yield* loadRow(orgId))
		})

		// The row is locked for the read-write, and the update sets only the requested fields, so
		// concurrent PATCHes with disjoint fields both stick and the audit diff is exact. With no row
		// there is nothing to lock: a first insert that loses the race re-reads the winner's row.
		const update = Effect.fn("TraceSamplingPolicyService.update")(function* (
			orgId: OrgId,
			request: TraceSamplingPolicyUpdateRequest,
		) {
			yield* Effect.annotateCurrentSpan({ orgId })
			const now = yield* Clock.currentTimeMillis
			const changed: SamplingPolicyChange = { updatedAt: now }
			if (request.traceSampleRatio !== undefined) changed.traceSampleRatio = request.traceSampleRatio
			if (request.alwaysKeepErrorSpans !== undefined)
				changed.alwaysKeepErrorSpans = request.alwaysKeepErrorSpans
			if (request.alwaysKeepSlowSpansMs !== undefined)
				changed.alwaysKeepSlowSpansMs = request.alwaysKeepSlowSpansMs
			return yield* dbExecute((db) => {
				const lockRow = db
					.run(selectRow(orgId).forUpdate())
					.pipe(Effect.map((rows) => Option.fromUndefinedOr(rows[0])))
				const readAfter = db
					.run(selectRow(orgId))
					.pipe(Effect.map((rows) => toDocument(Option.fromUndefinedOr(rows[0]))))
				return db.transaction(
					Effect.gen(function* () {
						const locked = yield* lockRow
						if (Option.isNone(locked)) {
							const created = yield* db.run(
								PG.insertInto(OrgIngestSamplingPolicies)
									.values({ orgId, createdAt: now, ...DEFAULT_TRACE_SAMPLING_POLICY, ...changed })
									.onConflictDoNothing()
									.returning("orgId"),
							)
							if (created.length > 0) return { before: toDocument(locked), after: yield* readAfter }
						}
						// A lost insert race waited for the winner to commit, so its row is visible now.
						const before = toDocument(Option.isSome(locked) ? locked : yield* lockRow)
						yield* db.run(
							PG.update(OrgIngestSamplingPolicies)
								.set(changed)
								.where(($) => [$.orgId.eq(orgId)]),
						)
						return { before, after: yield* readAfter }
					}),
				)
			})
		})

		return { get, update } satisfies TraceSamplingPolicyServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
