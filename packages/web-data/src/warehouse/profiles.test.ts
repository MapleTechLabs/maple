// The profile reads get a real HttpApiClient over a controlled fetch as their `MapleInternalHttp`,
// so request encoding and response decoding run.
import {
	MapleInternalApi,
	PROFILE_SPAN_IDS_MAX,
	ProfileSampleTypesRequest,
	ProfileStacksRequest,
} from "@maple/domain/http"
import { Effect, Layer, Option, Schema, Array as Arr, String as Str } from "effect"
import { FetchHttpClient } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { isWarehouseApiError } from "./effect-utils"
import {
	getProfile,
	getProfileSampleTypes,
	getProfileStacks,
	type ProfileScopeInput,
	type ProfileStacksInput,
} from "./profiles"
import { MapleInternalHttp } from "./warehouse-services"

const mocks = { fetch: vi.fn<typeof globalThis.fetch>() }

const InternalHttp = Layer.effect(
	MapleInternalHttp,
	HttpApiClient.make(MapleInternalApi, { baseUrl: "https://maple.test" }),
).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(Layer.succeed(FetchHttpClient.Fetch, mocks.fetch)))

const run = <A, E>(effect: Effect.Effect<A, E, MapleInternalHttp>) =>
	Effect.runPromise(effect.pipe(Effect.provide(InternalHttp)))

/** `"accepted"` when the read went through, else the tag of the failure it was refused with. */
const outcome = <A, E>(effect: Effect.Effect<A, E, MapleInternalHttp>) =>
	run(
		effect.pipe(
			Effect.match({
				onFailure: (error) => (isWarehouseApiError(error) ? error._tag : "an API error"),
				onSuccess: () => "accepted",
			}),
		),
	)

const json = (body: unknown) =>
	new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })

const requestUrl = (input: RequestInfo | URL): string =>
	typeof input === "string" ? input : input instanceof URL ? input.href : input.url

/** Every request the reads made: its path and JSON body, in order. */
const requests = () =>
	Promise.all(
		Arr.map(mocks.fetch.mock.calls, async ([input, init]) => ({
			path: new URL(requestUrl(input)).pathname,
			body: await new Response(init?.body).json(),
		})),
	)

const sampleType = (name: string, unit: string, value: number) => ({
	sampleType: name,
	sampleUnit: unit,
	value,
	samples: 10,
	profiles: 2,
	durationNano: 5_000_000_000,
})

const STACKS = {
	stacks: [{ frames: ["main"], files: ["/app/src/main.ts"], lines: [3], value: 4_000 }],
	totalValue: 4_000,
	totalStacks: 1,
	truncated: false,
}

/** The API as the reads see it: sample types first, then the stacks of the row they ask for. */
const answerWith = (types: ReadonlyArray<ReturnType<typeof sampleType>>) =>
	mocks.fetch.mockImplementation((input) =>
		Promise.resolve(
			json(Str.endsWith("/profile-sample-types")(requestUrl(input)) ? { data: types } : STACKS),
		),
	)

const WINDOW = { startTime: "2026-11-15 11:00:00", endTime: "2026-11-15 12:00:00" }
const SERVICE = { ...WINDOW, serviceName: "checkout-api" }
const TRACE = { ...WINDOW, traceId: "7f3a4b5c6d7e8f901234567890abcdef" }
const DECODE_ERROR = "@maple/web/errors/WarehouseDecodeError"

const spanIds = (count: number) => Arr.makeBy(count, (index) => Str.padStart(16, "0")(index.toString(16)))

// A block body: vitest would call a returned mock as the hook's cleanup.
beforeEach(() => {
	mocks.fetch.mockReset()
})

describe("getProfile", () => {
	test("asks for the stacks of the chosen sample type in that row's unit", async () => {
		answerWith([sampleType("alloc_space", "bytes", 9_000_000), sampleType("cpu", "nanoseconds", 4_000)])
		const profile = await run(getProfile({ data: SERVICE }))
		expect(Option.map(profile, (found) => [found.sampleType, found.sampleUnit])).toEqual(
			Option.some(["cpu", "nanoseconds"]),
		)
		expect(await requests()).toEqual([
			{ path: "/internal/query-engine/profile-sample-types", body: SERVICE },
			{
				path: "/internal/query-engine/profile-stacks",
				body: { ...SERVICE, sampleType: "cpu", sampleUnit: "nanoseconds" },
			},
		])
	})

	test("reads a service that sent no profiles as none, without asking for stacks", async () => {
		answerWith([])
		expect(await run(getProfile({ data: SERVICE }))).toEqual(Option.none())
		expect(Arr.map(await requests(), ({ path }) => path)).toEqual([
			"/internal/query-engine/profile-sample-types",
		])
	})

	test("reads the heavier unit of a sample type two producers report differently", async () => {
		answerWith([sampleType("cpu", "count", 9_000), sampleType("cpu", "nanoseconds", 4_000)])
		const profile = await run(getProfile({ data: SERVICE }))
		expect(Option.map(profile, (found) => found.sampleUnit)).toEqual(Option.some("count"))
		expect((await requests())[1]?.body).toEqual({ ...SERVICE, sampleType: "cpu", sampleUnit: "count" })
	})

	test("passes over a sample type the stacks read would refuse", async () => {
		answerWith([
			sampleType(Str.repeat(129)("a"), "count", 9_000),
			sampleType("", "count", 8_000),
			sampleType("wall", "nanoseconds", 10),
		])
		const profile = await run(getProfile({ data: SERVICE }))
		expect(Option.map(profile, (found) => found.sampleType)).toEqual(Option.some("wall"))
	})

	test("reads a scope whose every sample type is unreadable as having no profile", async () => {
		answerWith([sampleType("", "count", 8_000)])
		expect(await run(getProfile({ data: SERVICE }))).toEqual(Option.none())
		expect(mocks.fetch).toHaveBeenCalledTimes(1)
	})

	test("reads a sample type whose producer named no unit", async () => {
		answerWith([sampleType("unknown", "", 12)])
		const profile = await run(getProfile({ data: SERVICE }))
		expect(Option.map(profile, (found) => [found.sampleType, found.sampleUnit])).toEqual(
			Option.some(["unknown", ""]),
		)
		expect((await requests())[1]?.body).toEqual({ ...SERVICE, sampleType: "unknown", sampleUnit: "" })
	})

	test("leaves the scope keys it was not given out of both bodies", async () => {
		answerWith([sampleType("cpu", "nanoseconds", 4_000)])
		const scope = { ...TRACE, spanIds: spanIds(2) }
		await run(getProfile({ data: scope }))
		expect(Arr.map(await requests(), ({ body }) => body)).toEqual([
			scope,
			{ ...scope, sampleType: "cpu", sampleUnit: "nanoseconds" },
		])
	})
})

// Each input with whether the API's request takes it: the client must agree, and say so as a
// typed failure before any request leaves.
describe("profile read input", () => {
	const scopes: ReadonlyArray<readonly [string, ProfileScopeInput, boolean]> = [
		["a service's window", SERVICE, true],
		["one span", { ...TRACE, spanIds: spanIds(1) }, true],
		["the most spans", { ...TRACE, spanIds: spanIds(PROFILE_SPAN_IDS_MAX) }, true],
		["no spans", { ...TRACE, spanIds: [] }, false],
		["one span too many", { ...TRACE, spanIds: spanIds(PROFILE_SPAN_IDS_MAX + 1) }, false],
		["an undefined environment", { ...SERVICE, deploymentEnv: undefined }, false],
		["a time that is not one", { ...SERVICE, startTime: "yesterday" }, false],
	]

	const cpu = { sampleType: "cpu", sampleUnit: "nanoseconds" }
	const long = Str.repeat(129)("a")
	const stacks: ReadonlyArray<readonly [string, ProfileStacksInput, boolean]> = [
		["a type and its unit", { ...SERVICE, ...cpu }, true],
		["a type whose unit has no name", { ...SERVICE, sampleType: "unknown", sampleUnit: "" }, true],
		["an empty type", { ...SERVICE, ...cpu, sampleType: "" }, false],
		["a type that is too long", { ...SERVICE, ...cpu, sampleType: long }, false],
		["a unit that is too long", { ...SERVICE, ...cpu, sampleUnit: long }, false],
		["no spans", { ...TRACE, ...cpu, spanIds: [] }, false],
		["one span too many", { ...TRACE, ...cpu, spanIds: spanIds(PROFILE_SPAN_IDS_MAX + 1) }, false],
	]

	test.each(scopes)("the sample types read takes %s as the API does", async (_name, data, accepted) => {
		answerWith([])
		expect(Option.isSome(Schema.decodeOption(ProfileSampleTypesRequest)(data))).toBe(accepted)
		expect(await outcome(getProfileSampleTypes({ data }))).toBe(accepted ? "accepted" : DECODE_ERROR)
		expect(mocks.fetch).toHaveBeenCalledTimes(accepted ? 1 : 0)
	})

	test.each(stacks)("the stacks read takes %s as the API does", async (_name, data, accepted) => {
		answerWith([])
		expect(Option.isSome(Schema.decodeOption(ProfileStacksRequest)(data))).toBe(accepted)
		expect(await outcome(getProfileStacks({ data }))).toBe(accepted ? "accepted" : DECODE_ERROR)
		expect(mocks.fetch).toHaveBeenCalledTimes(accepted ? 1 : 0)
	})

	test("a profile of no spans is refused before the sample types are asked for", async () => {
		expect(await outcome(getProfile({ data: { ...TRACE, spanIds: [] } }))).toBe(DECODE_ERROR)
		expect(mocks.fetch).not.toHaveBeenCalled()
	})
})
