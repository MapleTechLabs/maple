import {
	ProfileSampleType,
	ProfileSampleTypesRequest,
	ProfileSampleUnit,
	ProfileStacksRequest,
} from "@maple/domain/http"
import { Effect, Option, Schema, Array as Arr } from "effect"
import { decodeInput, runWarehouseQuery } from "./effect-utils"
import { MapleInternalHttp } from "./warehouse-services"

// Continuous profiling reads: which sample types a scope has, then the heaviest stacks of one.
// A scope is a service's window, or the spans of one trace.

// The inputs are the API's own requests, so what decodes here is what the API accepts.
// An optional key is left out, never set to `undefined`.
export type ProfileScopeInput = typeof ProfileSampleTypesRequest.Encoded
export type ProfileStacksInput = typeof ProfileStacksRequest.Encoded

/** The stacks of one sample type in a scope, as the flame graph and the top functions read them. */
export interface Profile {
	readonly sampleType: string
	/** `nanoseconds` | `bytes` | `count`. */
	readonly sampleUnit: string
	/** Every stack in scope, including those past the read's cap. */
	readonly totalValue: number
	readonly totalStacks: number
	/** The summed length of the profiled windows: CPU time over it is average cores. */
	readonly durationNano: number
	/** The read's cap cut lighter stacks off: `stacks` sum to less than `totalValue`. */
	readonly truncated: boolean
	readonly stacks: ReadonlyArray<{
		readonly frames: ReadonlyArray<string>
		readonly files: ReadonlyArray<string>
		readonly lines: ReadonlyArray<number>
		readonly value: number
	}>
}

/** The sample types a scope sent, heaviest first; empty for a scope without profiles. */
export const getProfileSampleTypes = Effect.fn("QueryEngine.getProfileSampleTypes")(function* ({
	data,
}: {
	data: ProfileScopeInput
}) {
	const payload = yield* decodeInput(ProfileSampleTypesRequest, data, "getProfileSampleTypes")
	const result = yield* runWarehouseQuery("profileSampleTypes", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.profileSampleTypes({ payload })
		}),
	)
	return { sampleTypes: result.data }
})

/** The heaviest stacks of one sample type in one unit; the API bounds how many and how large. */
export const getProfileStacks = Effect.fn("QueryEngine.getProfileStacks")(function* ({
	data,
}: {
	data: ProfileStacksInput
}) {
	const payload = yield* decodeInput(ProfileStacksRequest, data, "getProfileStacks")
	return yield* runWarehouseQuery("profileStacks", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.profileStacks({ payload })
		}),
	)
})

/** The sample type a profile opens on: CPU when the scope sent it, else its heaviest type. */
const PREFERRED_SAMPLE_TYPE = "cpu"

/** Ingest stores what a producer sent; a row the stacks read would refuse is never chosen. */
const isReadable = Schema.is(Schema.Struct({ sampleType: ProfileSampleType, sampleUnit: ProfileSampleUnit }))

/**
 * A scope's profile in two reads: its sample types, then the stacks of one row, in that row's
 * unit. None when it sent no profiles, which is every service without a profiler.
 */
export const getProfile = Effect.fn("QueryEngine.getProfile")(function* ({
	data,
}: {
	data: ProfileScopeInput
}) {
	const sampleTypes = Arr.filter((yield* getProfileSampleTypes({ data })).sampleTypes, isReadable)
	const chosen = Arr.findFirst(sampleTypes, (row) => row.sampleType === PREFERRED_SAMPLE_TYPE).pipe(
		Option.orElse(() => Arr.head(sampleTypes)),
	)
	if (Option.isNone(chosen)) return Option.none<Profile>()
	const { sampleType, sampleUnit, durationNano } = chosen.value
	const read = yield* getProfileStacks({ data: { ...data, sampleType, sampleUnit } })
	return Option.some<Profile>({
		sampleType,
		sampleUnit,
		totalValue: read.totalValue,
		totalStacks: read.totalStacks,
		durationNano,
		truncated: read.truncated,
		stacks: read.stacks,
	})
})
