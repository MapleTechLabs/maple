// The span profile read gets a real HttpApiClient over a controlled fetch as its `MapleInternalHttp`,
// so request encoding and response decoding run.
import { MapleInternalApi } from "@maple/domain/http"
import { TraceId } from "@maple/domain"
import type { SpanProfileRequest } from "@maple/views/traces/trace-source"
import { MapleInternalHttp } from "@maple/web-data/warehouse/warehouse-services"
import { Effect, Layer, Option, Schema, Array as Arr, String as Str } from "effect"
import { FetchHttpClient } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { fetchSpanProfile, hasProfilingRollout } from "./trace-source"

const mocks = { fetch: vi.fn<typeof globalThis.fetch>() }

const InternalHttp = Layer.effect(
	MapleInternalHttp,
	HttpApiClient.make(MapleInternalApi, { baseUrl: "https://maple.test" }),
).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(Layer.succeed(FetchHttpClient.Fetch, mocks.fetch)))

const run = <A, E>(effect: Effect.Effect<A, E, MapleInternalHttp>) =>
	Effect.runPromise(effect.pipe(Effect.provide(InternalHttp)))

const json = (body: unknown) =>
	new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })

const requestUrl = (input: RequestInfo | URL): string =>
	typeof input === "string" ? input : input instanceof URL ? input.href : input.url

/** Every request the read made: its path and JSON body, in order. */
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

/** The API as the read sees it: sample types first, then the stacks of the one it asks for. */
const answerWith = (types: ReadonlyArray<ReturnType<typeof sampleType>>, stacks: unknown) =>
	mocks.fetch.mockImplementation((input) =>
		Promise.resolve(
			json(Str.endsWith("/profile-sample-types")(requestUrl(input)) ? { data: types } : stacks),
		),
	)

const request: SpanProfileRequest = {
	traceId: Schema.decodeSync(TraceId)("7f3a4b5c6d7e8f901234567890abcdef"),
	spanIds: ["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"],
	startTime: "2026-11-15 12:00:30.250",
	durationMs: 1500,
}

const enabled = Effect.succeed(true)

// A block body: vitest would call a returned mock as the hook's cleanup.
beforeEach(() => {
	mocks.fetch.mockReset()
})

describe("the span profile read", () => {
	test("reads the CPU stacks linked to the span and its descendants, in a padded window", async () => {
		answerWith([sampleType("alloc_space", "bytes", 9_000_000), sampleType("cpu", "nanoseconds", 4_000)], {
			stacks: [
				{ frames: ["main", "work"], files: ["/app/src/main.ts", ""], lines: [3, 0], value: 3_000 },
				{ frames: ["main"], files: ["/app/src/main.ts"], lines: [3], value: 1_000 },
			],
			totalValue: 4_000,
			totalStacks: 2,
			truncated: false,
		})
		const profile = await run(fetchSpanProfile(request, enabled))
		expect(Option.getOrNull(profile)).toEqual({
			sampleType: "cpu",
			sampleUnit: "nanoseconds",
			totalValue: 4_000,
			stacks: [
				{ frames: ["main", "work"], files: ["/app/src/main.ts", ""], lines: [3, 0], value: 3_000 },
				{ frames: ["main"], files: ["/app/src/main.ts"], lines: [3], value: 1_000 },
			],
		})
		const scope = {
			traceId: "7f3a4b5c6d7e8f901234567890abcdef",
			spanIds: ["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"],
			// A minute either side of the span's 12:00:30.250 to 12:00:31.750.
			startTime: "2026-11-15 11:59:30",
			endTime: "2026-11-15 12:01:31",
		}
		expect(await requests()).toEqual([
			{ path: "/internal/query-engine/profile-sample-types", body: scope },
			{
				path: "/internal/query-engine/profile-stacks",
				body: { ...scope, sampleType: "cpu", sampleUnit: "nanoseconds" },
			},
		])
	})

	test("falls back to the heaviest sample type when the spans have no CPU samples", async () => {
		answerWith(
			[sampleType("alloc_space", "bytes", 9_000_000), sampleType("alloc_objects", "count", 40)],
			{
				stacks: [{ frames: ["main"], files: [""], lines: [0], value: 9_000_000 }],
				totalValue: 9_000_000,
				totalStacks: 1,
				truncated: false,
			},
		)
		const profile = await run(fetchSpanProfile(request, enabled))
		expect(Option.map(profile, (found) => [found.sampleType, found.sampleUnit])).toEqual(
			Option.some(["alloc_space", "bytes"]),
		)
	})

	test("is none when no sample is linked to the spans, without asking for stacks", async () => {
		answerWith([], {})
		expect(Option.isNone(await run(fetchSpanProfile(request, enabled)))).toBe(true)
		expect(Arr.map(await requests(), ({ path }) => path)).toEqual([
			"/internal/query-engine/profile-sample-types",
		])
	})

	test("an org outside the profiling rollout gets no profile and sends no request", async () => {
		expect(Option.isNone(await run(fetchSpanProfile(request, Effect.succeed(false))))).toBe(true)
		expect(mocks.fetch).not.toHaveBeenCalled()
	})

	test("a span without descendants to name, or without a start time, has no profile", async () => {
		expect(Option.isNone(await run(fetchSpanProfile({ ...request, spanIds: [] }, enabled)))).toBe(true)
		expect(Option.isNone(await run(fetchSpanProfile({ ...request, startTime: "" }, enabled)))).toBe(true)
		expect(mocks.fetch).not.toHaveBeenCalled()
	})
})

describe("the profiling rollout flag", () => {
	test("a hosted org has it only when its metadata sets profiling to the literal true", () => {
		expect(hasProfilingRollout(true, { profiling: true })).toBe(true)
		expect(hasProfilingRollout(true, { profiling: "yes" })).toBe(false)
		expect(hasProfilingRollout(true, { releases: true })).toBe(false)
		expect(hasProfilingRollout(true, undefined)).toBe(false)
	})

	test("self-hosted has it whatever the metadata says", () => {
		expect(hasProfilingRollout(false, undefined)).toBe(true)
	})
})
