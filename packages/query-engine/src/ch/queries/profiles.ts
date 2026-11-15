// Continuous profiling reads over `profiles`: one row per distinct stack per exported profile,
// frames root first. A flame graph is the stacks of a window folded by `StackHash`; the client
// builds the tree, so the wire size is bounded by distinct stacks, not samples.
// Pinned to the managed route: profiles are written through `ingest` only, so an org on its own
// ClickHouse holds an empty copy of the table.

import * as T from "@maple-dev/effect-orm/clickhouse"
import * as CH from "@maple-dev/effect-orm/expr"
import { from, param } from "@maple-dev/effect-orm/clickhouse"
import * as Datasources from "@maple/domain/tinybird/datasources"
import { orgIdParam } from "../tables"

/** Most stacks one flame graph reads. The rest of the window is the gap to `totalValue`. */
export const PROFILE_STACKS_CAP = 2000

export interface ProfileScopeOpts {
	/** Binds `serviceName`. */
	readonly service?: boolean
	/** Binds `environment`. */
	readonly environment?: boolean
	/** Binds `serviceVersion`: one release's profile, the two sides of a diff. */
	readonly serviceVersion?: boolean
	/** Binds `spanId`: only the samples the producer linked to that span. */
	readonly span?: boolean
	/** Binds `traceId`. */
	readonly trace?: boolean
	/**
	 * Only the samples linked to one of these spans, inlined as escaped literals: a span and its
	 * descendants, since a sample belongs to the innermost span that was running.
	 */
	readonly spanIds?: ReadonlyArray<string>
}

/** A sample type is only comparable within one unit, so a read of its values names both. */
export interface ProfileTypeOpts extends ProfileScopeOpts {
	/** Binds `sampleUnit`: producers can report one sample type in different units. */
	readonly unit?: boolean
}

export interface ProfileStacksOpts extends ProfileTypeOpts {
	readonly limit?: number
}

type ProfilesAccessor = T.ColumnAccessor<typeof Datasources.profiles.columns>

const scopeConditions = ($: ProfilesAccessor, opts: ProfileScopeOpts) => [
	$.OrgId.eq(orgIdParam),
	CH.whenTrue(!!opts.service, () => $.ServiceName.eq(param.string("serviceName"))),
	$.Timestamp.gte(param.dateTime("startTime")),
	$.Timestamp.lte(param.dateTime("endTime")),
	CH.whenTrue(!!opts.environment, () => $.Environment.eq(param.string("environment"))),
	CH.whenTrue(!!opts.serviceVersion, () => $.ServiceVersion.eq(param.string("serviceVersion"))),
	CH.whenTrue(!!opts.span, () => $.SpanId.eq(param.string("spanId"))),
	CH.whenTrue(!!opts.trace, () => $.TraceId.eq(param.string("traceId"))),
	// An empty list names no span, and `IN ()` is not SQL: it matches nothing.
	CH.whenTrue(opts.spanIds !== undefined, () =>
		opts.spanIds === undefined || opts.spanIds.length === 0
			? CH.rawCond("1 = 0")
			: CH.inList($.SpanId, opts.spanIds),
	),
]

const typeConditions = ($: ProfilesAccessor, opts: ProfileTypeOpts) => [
	...scopeConditions($, opts),
	$.SampleType.eq(param.string("sampleType")),
	CH.whenTrue(!!opts.unit, () => $.SampleUnit.eq(param.string("sampleUnit"))),
]

/**
 * The heaviest stacks of one sample type in the window, each with its summed value. `totalValue`
 * and `totalStacks` cover every stack in scope, so a reader can size what the cap cut off.
 * Binds `sampleType`, and `sampleUnit` with `unit`.
 */
export function profileStacksQuery(opts: ProfileStacksOpts = {}) {
	return from(Datasources.profiles)
		.select(($) => ({
			// A UInt64 identity: stringified so no client rounds it.
			stackHash: CH.toString_($.StackHash),
			frames: CH.rawExpr("any(Frames)", T.array(T.string)),
			files: CH.rawExpr("any(FrameFiles)", T.array(T.string)),
			lines: CH.rawExpr("any(FrameLines)", T.array(T.int32)),
			value: CH.sum($.Value),
			samples: CH.sum($.Samples),
			totalValue: CH.rawExpr("sum(sum(Value)) OVER ()", T.int64),
			totalStacks: CH.rawExpr("count() OVER ()", T.uint64),
		}))
		.where(($) => typeConditions($, opts))
		.groupBy("stackHash")
		.orderBy(["value", "desc"], ["stackHash", "asc"])
		.limit(opts.limit ?? PROFILE_STACKS_CAP)
		.format("JSON")
		.route("ingest")
}

/**
 * The sample types present in scope, one row per type and unit, heaviest first: what a profile selector offers, and the
 * cheap "does this service (or span) have profiles at all" probe. `durationNano` is the summed
 * profile windows, so `value / durationNano` is average cores for a CPU type.
 */
export function profileSampleTypesQuery(opts: ProfileScopeOpts = {}) {
	return from(Datasources.profiles)
		.select(($) => ({
			sampleType: $.SampleType,
			sampleUnit: $.SampleUnit,
			value: CH.sum($.Value),
			samples: CH.sum($.Samples),
			profiles: CH.rawExpr("uniqExact(ProfileId)", T.uint64),
			// Each profile's window once, however many rows it has: every row of a profile carries
			// its window, so one (profile, window) pair per profile is summed.
			durationNano: CH.rawExpr(
				"toUInt64(arraySum(arrayMap(p -> p.2, groupUniqArray((ProfileId, DurationNano)))))",
				T.uint64,
			),
		}))
		.where(($) => scopeConditions($, opts))
		.groupBy("sampleType", "sampleUnit")
		.orderBy(["value", "desc"], ["sampleType", "asc"], ["sampleUnit", "asc"])
		.format("JSON")
		.route("ingest")
}

/** The value of one sample type per bucket. Binds `sampleType`, `bucketSeconds`, and `sampleUnit` with `unit`. */
export function profileTimeseriesQuery(opts: ProfileTypeOpts = {}) {
	return from(Datasources.profiles)
		.select(($) => ({
			bucket: CH.toStartOfInterval($.Timestamp, param.int("bucketSeconds")),
			value: CH.sum($.Value),
		}))
		.where(($) => typeConditions($, opts))
		.groupBy("bucket")
		.orderBy(["bucket", "asc"])
		.format("JSON")
		.route("ingest")
}
