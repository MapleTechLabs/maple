// Continuous profiling reads for the dashboard: the sample types in a scope, and the heaviest
// stacks of one. A scope is a service's window or the spans of one trace, never the whole org.
import {
	type ProfileSampleTypesRequest,
	type ProfileStacksRequest,
	QueryEngineValidationError,
	type TenantContext,
} from "@maple/domain/http"
import { baselineWarehouseCapabilities, CH } from "@maple/query-engine"
import { Queries, queryDefinitionCacheIdentity } from "@maple/query-engine/registry"
import { timeRangeCache } from "@maple/query-engine/runtime"
import { Clock, Effect, Array as Arr } from "effect"
import { makeQueryRunners, type QueryRunnerDeps } from "@maple/backend/queries/query-runner"
import { isMissingProfiles } from "@maple/backend/services/warehouse/missing-table"

/**
 * The most a stacks read may materialize. Frames are customer strings, up to 256 a stack, so the
 * row cap alone does not bound the answer.
 */
export const PROFILE_STACKS_RESPONSE_BYTES = 8_000_000

/** The cap a read retries with when the full one is over the byte ceiling (very deep stacks). */
export const PROFILE_STACKS_FALLBACK_CAP = 250

const RESPONSE_LIMIT = "@maple/query-engine/execution/WarehouseResponseLimitError"

const EMPTY_STACKS = { stacks: [], totalValue: 0, totalStacks: 0, truncated: false }

/** A read names a service, or a trace with its spans: nothing reads every stack of an org. */
const requireScope = (payload: ProfileSampleTypesRequest) =>
	payload.serviceName !== undefined || (payload.traceId !== undefined && payload.spanIds !== undefined)
		? Effect.void
		: Effect.fail(
				new QueryEngineValidationError({
					message: "A profile read needs a serviceName, or a traceId with spanIds.",
					details: ["MissingProfileScope"],
				}),
			)

export const makeProfileReads = (deps: QueryRunnerDeps) => {
	const { warehouse, queryEngine } = deps
	const { runQuery } = makeQueryRunners(deps)

	/** Heaviest first; empty for a scope without profiles, and for a cluster without the table. */
	const sampleTypes = Effect.fn("ProfileReads.sampleTypes")(function* (
		tenant: TenantContext,
		payload: ProfileSampleTypesRequest,
	) {
		yield* requireScope(payload)
		return yield* runQuery(Queries.profileSampleTypes, tenant, payload).pipe(
			Effect.catchIf(isMissingProfiles, () => Effect.succeed([])),
		)
	})

	const boundedStacks = (tenant: TenantContext, payload: ProfileStacksRequest, limit: number) =>
		warehouse
			.compiledQueryBounded(
				tenant,
				Queries.profileStacks.compile(
					{ ...payload, limit },
					tenant.orgId,
					baselineWarehouseCapabilities(),
				),
				{
					profile: Queries.profileStacks.profile,
					context: Queries.profileStacks.id,
					responseLimits: { maxRows: limit, maxBytes: PROFILE_STACKS_RESPONSE_BYTES },
				},
			)
			.pipe(
				Effect.map((rows) => {
					const totalStacks = rows[0]?.totalStacks ?? 0
					return {
						stacks: Arr.map(rows, ({ frames, files, lines, value }) => ({
							frames,
							files,
							lines,
							value,
						})),
						totalValue: rows[0]?.totalValue ?? 0,
						totalStacks,
						truncated: rows.length < totalStacks,
					}
				}),
			)

	/**
	 * The heaviest stacks of one sample type in the request's unit, bounded twice: `CH.PROFILE_STACKS_CAP` rows and
	 * `PROFILE_STACKS_RESPONSE_BYTES`. Over the bytes it reads fewer stacks once, then refuses.
	 */
	const stacks = Effect.fn("ProfileReads.stacks")(function* (
		tenant: TenantContext,
		payload: ProfileStacksRequest,
	) {
		yield* requireScope(payload)
		const nowMs = yield* Clock.currentTimeMillis
		const read = yield* queryEngine
			.cachedDirect(
				tenant,
				Queries.profileStacks.id,
				queryDefinitionCacheIdentity(Queries.profileStacks, payload),
				boundedStacks(tenant, payload, CH.PROFILE_STACKS_CAP).pipe(
					Effect.catchTag(RESPONSE_LIMIT, () =>
						boundedStacks(tenant, payload, PROFILE_STACKS_FALLBACK_CAP),
					),
					// Null: even the smaller read was over the ceiling.
					Effect.catchTag(RESPONSE_LIMIT, () => Effect.succeed(null)),
				),
				timeRangeCache(payload, nowMs),
			)
			.pipe(Effect.catchIf(isMissingProfiles, () => Effect.succeed(EMPTY_STACKS)))
		if (read === null) {
			return yield* new QueryEngineValidationError({
				message: "This profile's call stacks are too large to read. Choose a shorter time range.",
				details: ["ProfileStacksTooLarge"],
			})
		}
		yield* Effect.annotateCurrentSpan({
			"maple.profile.stack_count": read.stacks.length,
			"maple.profile.truncated": read.truncated,
		})
		return read
	})

	return { sampleTypes, stacks } as const
}
