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

		const loadRow = (orgId: OrgId) =>
			dbExecute((db) =>
				db.run(
					PG.from(OrgIngestSamplingPolicies)
						.select()
						.where(($) => [$.orgId.eq(orgId)])
						.limit(1),
				),
			).pipe(Effect.map((rows) => Option.fromUndefinedOr(rows[0])))

		const get = Effect.fn("TraceSamplingPolicyService.get")(function* (orgId: OrgId) {
			yield* Effect.annotateCurrentSpan({ orgId })
			return toDocument(yield* loadRow(orgId))
		})

		const update = Effect.fn("TraceSamplingPolicyService.update")(function* (
			orgId: OrgId,
			request: TraceSamplingPolicyUpdateRequest,
		) {
			yield* Effect.annotateCurrentSpan({ orgId })
			const before = toDocument(yield* loadRow(orgId))
			const now = yield* Clock.currentTimeMillis
			const next = {
				traceSampleRatio: request.traceSampleRatio ?? before.traceSampleRatio,
				alwaysKeepErrorSpans: request.alwaysKeepErrorSpans ?? before.alwaysKeepErrorSpans,
				alwaysKeepSlowSpansMs:
					request.alwaysKeepSlowSpansMs === undefined
						? before.alwaysKeepSlowSpansMs
						: request.alwaysKeepSlowSpansMs,
				updatedAt: now,
			}
			yield* dbExecute((db) =>
				db.run(
					PG.insertInto(OrgIngestSamplingPolicies)
						.values({ orgId, createdAt: now, ...next })
						.onConflictDoUpdate({ target: ["orgId"], set: next }),
				),
			)
			return { before, after: toDocument(yield* loadRow(orgId)) }
		})

		return { get, update } satisfies TraceSamplingPolicyServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
