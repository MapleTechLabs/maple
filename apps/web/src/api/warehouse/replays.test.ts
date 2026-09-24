// TEST-SEAM: The adapter's process-global client layer is replaced with a real
// HttpApiClient over a controlled fetch; request encoding and response decoding run.
import { describe, expect, it } from "@effect/vitest"
import { beforeEach, vi } from "vitest"
import { Effect, Schema } from "effect"
import { OpenApi } from "effect/unstable/httpapi"
import {
	MapleApiV2,
	V2SessionReplay,
	V2SessionReplayListItem,
	V2SessionReplayNotFound,
	V2ParameterInvalid,
} from "@maple/domain/http/v2"
import { getReplay, getReplaysForTrace, getSessionTranscript, listReplays } from "./replays"

const mocks = vi.hoisted(() => ({ fetch: vi.fn<typeof globalThis.fetch>() }))
vi.mock("./effect-utils", async () => {
	const actual = await vi.importActual<typeof import("./effect-utils")>("./effect-utils")
	const { Effect, Layer } = await import("effect")
	const { FetchHttpClient } = await import("effect/unstable/http")
	const { HttpApiClient } = await import("effect/unstable/httpapi")
	const { MapleApiV2 } = await import("@maple/domain/http/v2")
	const { MapleApiV2AtomClient } = await import("@/lib/services/common/v2-atom-client")
	const layer = Layer.effect(
		MapleApiV2AtomClient,
		HttpApiClient.make(MapleApiV2, { baseUrl: "https://maple.test" }),
	).pipe(
		Layer.provide(FetchHttpClient.layer),
		Layer.provide(Layer.succeed(FetchHttpClient.Fetch, mocks.fetch)),
	)
	return {
		...actual,
		runWarehouseQueryV2: <A, E>(
			_operation: string,
			execute: () => Effect.Effect<
				A,
				E,
				import("@/lib/services/common/v2-atom-client").MapleApiV2AtomClient
			>,
		) => Effect.suspend(execute).pipe(Effect.provide(layer)),
	}
})

const schemas = OpenApi.fromApi(MapleApiV2).components.schemas
const examples = Schema.decodeUnknownSync(Schema.Array(Schema.Record(Schema.String, Schema.Unknown)))
const listWire = examples(schemas.SessionReplayListItem.examples)[0]!
const detailWire = examples(schemas.SessionReplay.examples)[0]!
const sessionId = Schema.decodeUnknownSync(V2SessionReplay)(detailWire).id
const publicId = Schema.encodeSync(V2SessionReplay)(Schema.decodeUnknownSync(V2SessionReplay)(detailWire)).id
const window = { startTime: "2026-09-01 00:00:00", endTime: "2026-09-02 00:00:00" }
const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const page = (data: readonly unknown[], next: string | null = null) => ({
	object: "list",
	data,
	has_more: next !== null,
	next_cursor: next,
})

beforeEach(() => mocks.fetch.mockReset())

describe("replay v2 HTTP adapters", () => {
	it.effect("encodes search filters and preserves the server cursor and unknown recording state", () =>
		Effect.gen(function* () {
			const wire = { ...listWire, recorded: null }
			mocks.fetch.mockResolvedValue(json(page([wire], "opaque-next")))
			const result = yield* listReplays({
				data: {
					...window,
					visitorId: "visitor",
					userSearch: "Ada",
					hasErrors: false,
					activeTimeMinMs: 500,
					cursor: "opaque-before",
				},
			})
			const [url, init] = mocks.fetch.mock.calls[0]!
			expect(String(url)).toBe("https://maple.test/v2/session_replays/search")
			expect(yield* Effect.promise(() => new Response(init?.body).json())).toMatchObject({
				start_time: "2026-09-01T00:00:00.000Z",
				end_time: "2026-09-02T00:00:00.000Z",
				visitor_id: "visitor",
				user_search: "Ada",
				has_errors: false,
				active_time_min_ms: 500,
				cursor: "opaque-before",
				limit: 50,
			})
			expect(result).toMatchObject({
				hasMore: true,
				nextCursor: "opaque-next",
				data: [
					{
						sessionId: Schema.decodeUnknownSync(V2SessionReplayListItem)(wire).id,
						visitorId: "visitor_123",
						utmSource: "newsletter",
						entryPath: "/dashboard",
						recorded: "",
					},
				],
			})
		}),
	)

	it.effect("encodes a decoded ID exactly once and maps the full detail", () =>
		Effect.gen(function* () {
			mocks.fetch.mockResolvedValue(json(detailWire))
			const result = yield* getReplay({
				data: { sessionId, windowStart: window.startTime, windowEnd: window.endTime },
			})
			const url = new URL(String(mocks.fetch.mock.calls[0]![0]))
			expect(url.pathname).toBe(`/v2/session_replays/${publicId}`)
			expect(url.searchParams.get("window_start")).toBe("2026-09-01T00:00:00.000Z")
			expect(result.data).toMatchObject({
				sessionId,
				visitorId: "visitor_123",
				visitorIsNew: false,
				userTraits: "{}",
				utmCampaign: "launch",
				host: "app.example.com",
				language: "en",
				lastActivityAt: "2026-07-15T09:18:30.000Z",
			})
		}),
	)

	it.effect("keeps missing-session empty states but does not swallow other errors", () =>
		Effect.gen(function* () {
			mocks.fetch.mockImplementation(async () =>
				json({ error: V2SessionReplayNotFound.make().error }, 404),
			)
			expect(yield* getReplay({ data: { sessionId } })).toEqual({ data: null })
			expect(yield* getSessionTranscript({ data: { sessionId } })).toEqual({ data: [] })
			const invalid = { error: V2ParameterInvalid.make().error }
			mocks.fetch.mockImplementation(async () => json(invalid, 400))
			expect(yield* Effect.flip(getReplay({ data: { sessionId } }))).toEqual(invalid)
		}),
	)

	it.effect("collects transcript pages and preserves custom properties", () =>
		Effect.gen(function* () {
			const event = {
				object: "session_replay.transcript_event",
				timestamp: "2026-09-01T00:00:01.000Z",
				seq: 1,
				type: "custom",
				url: "/signup",
				trace_id: null,
				level: null,
				message: "signup",
				target_selector: null,
				target_text: null,
				net_method: null,
				net_url: null,
				net_status: null,
				net_duration_ms: null,
				error_stack: null,
				attributes: '{"plan":"pro"}',
			}
			mocks.fetch
				.mockResolvedValueOnce(json(page([event], "next-events")))
				.mockResolvedValueOnce(json(page([{ ...event, seq: 2 }])))
			const result = yield* getSessionTranscript({ data: { sessionId, windowStart: window.startTime } })
			expect(result.data.map((event) => event.seq)).toEqual([1, 2])
			expect(result.data[0]).toMatchObject({ attributes: '{"plan":"pro"}', level: "", netStatus: 0 })
			const url = new URL(String(mocks.fetch.mock.calls[1]![0]))
			expect(url.pathname).toBe(`/v2/session_replays/${publicId}/transcript`)
			expect(url.searchParams.get("cursor")).toBe("next-events")
			expect(url.searchParams.get("limit")).toBe("100")
			expect(url.searchParams.get("window_start")).toBe("2026-09-01T00:00:00.000Z")
		}),
	)

	it.effect("collects every trace-correlation page using POST cursors", () =>
		Effect.gen(function* () {
			const ref = {
				object: "session_replay.ref",
				id: publicId,
				start_time: "2026-09-01T00:00:01.000Z",
				duration_ms: null,
			}
			mocks.fetch
				.mockResolvedValueOnce(json(page([ref], "next-replays")))
				.mockResolvedValueOnce(json(page([ref])))
			const traceId = "7f3a4b5c6d7e8f901234567890abcdef"
			const result = yield* getReplaysForTrace({ data: { ...window, traceId } })
			expect(result.data).toHaveLength(2)
			expect(result.data[0].sessionId).toBe(sessionId)
			const [url, init] = mocks.fetch.mock.calls[1]!
			expect(String(url)).toBe("https://maple.test/v2/session_replays/for_trace")
			expect(yield* Effect.promise(() => new Response(init?.body).json())).toMatchObject({
				trace_id: traceId,
				cursor: "next-replays",
				limit: 100,
			})
		}),
	)
})
