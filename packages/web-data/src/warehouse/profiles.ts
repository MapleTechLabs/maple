import { SpanId, TraceId } from "@maple/domain"
import {
	DeploymentEnvironment,
	ProfileSampleTypesRequest,
	ProfileStacksRequest,
	ServiceName,
} from "@maple/domain/http"
import { Effect, Option, Schema, Array as Arr } from "effect"
import { WarehouseDateTimeString, decodeInput, runWarehouseQuery } from "./effect-utils"
import { MapleInternalHttp } from "./warehouse-services"

// Continuous profiling reads: which sample types a scope has, then the heaviest stacks of one.
// A scope is a service's window, or the spans of one trace.

const ProfileScopeInputSchema = Schema.Struct({
	startTime: WarehouseDateTimeString,
	endTime: WarehouseDateTimeString,
	serviceName: Schema.optional(ServiceName),
	deploymentEnv: Schema.optional(DeploymentEnvironment),
	traceId: Schema.optional(TraceId),
	/** A span and the spans under it. */
	spanIds: Schema.optional(Schema.Array(SpanId)),
})

export type ProfileScopeInput = (typeof ProfileScopeInputSchema)["Encoded"]

const ProfileStacksInputSchema = Schema.Struct({
	...ProfileScopeInputSchema.fields,
	sampleType: Schema.String,
})

export type ProfileStacksInput = (typeof ProfileStacksInputSchema)["Encoded"]

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
	const input = yield* decodeInput(ProfileScopeInputSchema, data, "getProfileSampleTypes")
	const result = yield* runWarehouseQuery("profileSampleTypes", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.profileSampleTypes({
				payload: new ProfileSampleTypesRequest(input),
			})
		}),
	)
	return { sampleTypes: result.data }
})

/** The heaviest stacks of one sample type; the API bounds how many and how large. */
export const getProfileStacks = Effect.fn("QueryEngine.getProfileStacks")(function* ({
	data,
}: {
	data: ProfileStacksInput
}) {
	const input = yield* decodeInput(ProfileStacksInputSchema, data, "getProfileStacks")
	return yield* runWarehouseQuery("profileStacks", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.profileStacks({ payload: new ProfileStacksRequest(input) })
		}),
	)
})

/** The sample type a profile opens on: CPU when the scope sent it, else its heaviest type. */
const PREFERRED_SAMPLE_TYPE = "cpu"

/**
 * A scope's profile in two reads: its sample types, then the stacks of one. None when it sent no
 * profiles, which is every service without a profiler.
 */
export const getProfile = Effect.fn("QueryEngine.getProfile")(function* ({
	data,
}: {
	data: ProfileScopeInput
}) {
	const { sampleTypes } = yield* getProfileSampleTypes({ data })
	const chosen = Arr.findFirst(sampleTypes, (row) => row.sampleType === PREFERRED_SAMPLE_TYPE).pipe(
		Option.orElse(() => Arr.head(sampleTypes)),
	)
	if (Option.isNone(chosen)) return Option.none<Profile>()
	const { sampleType, sampleUnit, durationNano } = chosen.value
	const read = yield* getProfileStacks({ data: { ...data, sampleType } })
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
