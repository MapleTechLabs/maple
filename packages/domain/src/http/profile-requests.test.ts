import { Option, Schema, Array as Arr, String as Str } from "effect"
import { describe, expect, it } from "vitest"
import { PROFILE_SPAN_IDS_MAX, ProfileSampleTypesRequest, ProfileStacksRequest } from "./query-engine"

const WINDOW = { startTime: "2026-11-15 11:00:00", endTime: "2026-11-15 12:00:00" }
const SERVICE = { ...WINDOW, serviceName: "checkout-api" }
const TRACE = { ...WINDOW, traceId: "7f3a4b5c6d7e8f901234567890abcdef" }

const decoders = {
	sampleTypes: Schema.decodeUnknownOption(ProfileSampleTypesRequest),
	stacks: Schema.decodeUnknownOption(ProfileStacksRequest),
}

/** Whether the request decodes: a refusal here is the endpoint's 400. */
const accepts = (request: keyof typeof decoders, input: unknown) => Option.isSome(decoders[request](input))

const spanIds = (count: number) => Arr.makeBy(count, (index) => Str.padStart(16, "0")(index.toString(16)))

describe("profile stacks request", () => {
	it("names the unit of the sample type it reads", () => {
		expect(accepts("stacks", { ...SERVICE, sampleType: "cpu", sampleUnit: "nanoseconds" })).toBe(true)
		expect(accepts("stacks", { ...SERVICE, sampleType: "cpu" })).toBe(false)
		expect(accepts("stacks", { ...SERVICE, sampleUnit: "nanoseconds" })).toBe(false)
	})

	it("takes the empty unit a profile without one is stored with, and no empty sample type", () => {
		expect(accepts("stacks", { ...SERVICE, sampleType: "unknown", sampleUnit: "" })).toBe(true)
		expect(accepts("stacks", { ...SERVICE, sampleType: "", sampleUnit: "nanoseconds" })).toBe(false)
	})

	it("rejects a sample type or unit longer than 128 characters", () => {
		const long = Str.repeat(129)("a")
		expect(accepts("stacks", { ...SERVICE, sampleType: long, sampleUnit: "count" })).toBe(false)
		expect(accepts("stacks", { ...SERVICE, sampleType: "cpu", sampleUnit: long })).toBe(false)
		expect(
			accepts("stacks", {
				...SERVICE,
				sampleType: Str.repeat(128)("a"),
				sampleUnit: Str.repeat(128)("b"),
			}),
		).toBe(true)
	})
})

describe("profile request scope", () => {
	it("names between one span and the span cap", () => {
		expect(accepts("sampleTypes", { ...TRACE, spanIds: spanIds(1) })).toBe(true)
		expect(accepts("sampleTypes", { ...TRACE, spanIds: spanIds(PROFILE_SPAN_IDS_MAX) })).toBe(true)
		expect(accepts("sampleTypes", { ...TRACE, spanIds: [] })).toBe(false)
		expect(accepts("sampleTypes", { ...TRACE, spanIds: spanIds(PROFILE_SPAN_IDS_MAX + 1) })).toBe(false)
		expect(
			accepts("stacks", { ...TRACE, spanIds: [], sampleType: "cpu", sampleUnit: "nanoseconds" }),
		).toBe(false)
	})

	// Strict equality: a key holding `undefined` is not the same body as one without the key.
	it("leaves an unset scope key out of the body instead of sending it undefined", () => {
		const encodeTypes = Schema.encodeSync(ProfileSampleTypesRequest)
		expect(encodeTypes(Schema.decodeSync(ProfileSampleTypesRequest)(SERVICE))).toStrictEqual(SERVICE)
		const stacks = { ...TRACE, spanIds: spanIds(2), sampleType: "cpu", sampleUnit: "nanoseconds" }
		const encodeStacks = Schema.encodeSync(ProfileStacksRequest)
		expect(encodeStacks(Schema.decodeSync(ProfileStacksRequest)(stacks))).toStrictEqual(stacks)
	})

	it("refuses a scope key that is present but undefined", () => {
		expect(accepts("sampleTypes", { ...SERVICE, deploymentEnv: undefined })).toBe(false)
		expect(accepts("sampleTypes", { ...WINDOW, serviceName: undefined })).toBe(false)
		expect(accepts("sampleTypes", { ...SERVICE, traceId: undefined, spanIds: undefined })).toBe(false)
	})
})
