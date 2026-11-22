import { describe, expect, it } from "vitest"
import { Effect, Array as Arr, Record as Rec, String as Str } from "effect"
import { gzipSync } from "node:zlib"
import type { InsertBatch } from "./insert-batcher"
import { LocalInsertError } from "./insert-batcher"
import { decodeJsonSync } from "./json"
import {
	ingestSessionBlob,
	ingestSessionEvents,
	ingestSessionMeta,
	MAX_REPLAY_CHUNK_BYTES,
	sessionColumns,
} from "./session-ingest"

const recorder = () => {
	const batches: InsertBatch[] = []
	return {
		batches,
		inserts: {
			insert: (next: ReadonlyArray<InsertBatch>) =>
				Effect.sync(() => {
					batches.push(...next)
					return Arr.reduce(
						next,
						0,
						(n, b) => n + Arr.filter(Str.split("\n")(b.ndjson), (l) => l !== "").length,
					)
				}),
		},
		rows: (): unknown[] =>
			Arr.flatMap(batches, (b) => Arr.map(Str.split("\n")(b.ndjson), (line) => decodeJsonSync(line))),
	}
}

const ndjson = (...rows: unknown[]) =>
	new TextEncoder().encode(
		Arr.join(
			Arr.map(rows, (r) => JSON.stringify(r)),
			"\n",
		) + "\n",
	)

const run = Effect.runPromise

const metaRow = {
	session_id: "sess_1",
	start_time: "2026-11-16 10:00:00.123",
	status: "active",
	version: 1,
	billable_start: 1,
	user_id: "u1",
	url_initial: "https://shop.test/",
	user_agent: "UA",
	browser_name: "Chrome",
	os_name: "macOS",
	device_type: "desktop",
	service_name: "shop-web",
	resource_attributes: { "maple.session.recorded": "true" },
	visitor_id: "v1",
	visitor_is_new: 1,
	user_traits: { plan: "pro" },
	referrer: "https://www.Google.com/search?q=x",
	host: "shop.test",
	country: "US",
	org_id: "someone-else",
	page_views: 3,
}

describe("POST /v1/sessionReplays/meta", () => {
	it("stores one session_replays row per line with only known columns", async () => {
		const sink = recorder()
		const result = await run(ingestSessionMeta(sink.inserts, new Headers(), ndjson(metaRow)))
		expect(result.response.status).toBe(200)
		expect(await result.response.json()).toEqual({ accepted: 1 })
		expect(sink.batches[0]?.datasource).toBe("session_replays")
		const [row] = sink.rows()
		expect(row).toMatchObject({
			session_id: "sess_1",
			start_time: "2026-11-16 10:00:00.123",
			version: 1,
			page_views: 3,
			resource_attributes: { "maple.session.recorded": "true" },
			user_traits: { plan: "pro" },
			// Server-derived: the client's country is overwritten, the referrer host normalized.
			country: "",
			referrer_host: "google.com",
		})
		expect(row).not.toHaveProperty("org_id")
		expect(row).not.toHaveProperty("billable_start")
	})

	it("stores a cookieless visitor as unidentified, with no proxy to derive an id from", async () => {
		const sink = recorder()
		await run(
			ingestSessionMeta(
				sink.inserts,
				new Headers(),
				ndjson({ ...metaRow, visitor_id: "cookieless", visitor_is_new: 1 }),
			),
		)
		expect(sink.rows()[0]).toMatchObject({ visitor_id: "", visitor_is_new: 0 })
	})

	it("clamps long values and drops off-type fields instead of failing the insert", async () => {
		const sink = recorder()
		const traits = Rec.fromEntries(Arr.map(Arr.range(1, 40), (i) => [`k${i}`, i]))
		await run(
			ingestSessionMeta(
				sink.inserts,
				new Headers(),
				ndjson({
					...metaRow,
					utm_campaign: Str.repeat(500)("c"),
					user_email: Str.repeat(1000)("é"),
					user_name: 42,
					page_views: -1,
					user_traits: traits,
				}),
			),
		)
		const [row] = sink.rows()
		expect(row).toMatchObject({ utm_campaign: Str.repeat(128)("c"), user_email: Str.repeat(512)("é") })
		expect(row).not.toHaveProperty("user_name")
		expect(row).not.toHaveProperty("page_views")
		expect(Rec.keys((row as { user_traits: object }).user_traits)).toHaveLength(24)
		expect((row as { user_traits: Record<string, string> }).user_traits.k1).toBe("1")
	})

	it("treats a self-referral as no referrer", async () => {
		const sink = recorder()
		await run(
			ingestSessionMeta(
				sink.inserts,
				new Headers(),
				ndjson({ ...metaRow, referrer: "https://www.shop.test/a", host: "shop.test" }),
			),
		)
		expect(sink.rows()[0]).toMatchObject({ referrer_host: "" })
	})

	it("drops rows without a session id or start time and rejects malformed JSON", async () => {
		const sink = recorder()
		const result = await run(
			ingestSessionMeta(sink.inserts, new Headers(), ndjson({ ...metaRow, start_time: "yesterday" })),
		)
		expect(await result.response.json()).toEqual({ accepted: 0 })
		expect(result.dropped).toBe(1)
		expect(sink.batches).toEqual([])

		const bad = await run(
			ingestSessionMeta(sink.inserts, new Headers(), new TextEncoder().encode("{not json\n")),
		)
		expect(bad.response.status).toBe(400)
	})

	it("normalizes an ISO start time and drops an impossible one", async () => {
		const sink = recorder()
		const result = await run(
			ingestSessionMeta(
				sink.inserts,
				new Headers(),
				ndjson(
					{ ...metaRow, start_time: "2026-11-16T10:00:00.123456Z" },
					{ ...metaRow, session_id: "sess_2", start_time: "2026-13-45 99:99:99" },
				),
			),
		)
		expect(await result.response.json()).toEqual({ accepted: 1 })
		expect(sink.rows()[0]).toMatchObject({ start_time: "2026-11-16 10:00:00.123456" })
	})

	it("reads a gzip content-encoding", async () => {
		const sink = recorder()
		const result = await run(
			ingestSessionMeta(
				sink.inserts,
				new Headers({ "content-encoding": "gzip" }),
				gzipSync(ndjson(metaRow, { ...metaRow, session_id: "sess_2" })),
			),
		)
		expect(result.accepted).toBe(2)
	})
})

describe("POST /v1/sessionEvents", () => {
	const event = {
		session_id: "sess_1",
		timestamp: "2026-11-16 10:00:01.000",
		seq: 4,
		type: "custom",
		url: "https://shop.test/cart",
		message: "checkout",
		attributes: { amount: 12, currency: "EUR" },
		net_status: 0,
	}

	it("stores a cookieless visitor's events as unidentified", async () => {
		const sink = recorder()
		await run(
			ingestSessionEvents(sink.inserts, new Headers(), ndjson({ ...event, visitor_id: "cookieless" })),
		)
		expect(sink.rows()[0]).toMatchObject({ visitor_id: "" })
	})

	it("stores known event types and drops unknown ones", async () => {
		const sink = recorder()
		const result = await run(
			ingestSessionEvents(sink.inserts, new Headers(), ndjson(event, { ...event, type: "keylogger" })),
		)
		expect(await result.response.json()).toEqual({ accepted: 1 })
		expect(result.dropped).toBe(1)
		expect(sink.batches[0]?.datasource).toBe("session_events")
		expect(sink.rows()).toEqual([
			{
				session_id: "sess_1",
				timestamp: "2026-11-16 10:00:01.000",
				seq: 4,
				type: "custom",
				url: "https://shop.test/cart",
				message: "checkout",
				attributes: { amount: "12", currency: "EUR" },
				net_status: 0,
			},
		])
	})

	it("truncates the message and caps attributes", async () => {
		const sink = recorder()
		const attributes = Rec.fromEntries(
			Arr.map(Arr.range(1, 50), (i) => [`${Str.repeat(100)("k")}${i}`, Str.repeat(2000)("v")]),
		)
		await run(
			ingestSessionEvents(
				sink.inserts,
				new Headers(),
				ndjson({ ...event, message: Str.repeat(5000)("m"), attributes }),
			),
		)
		const [row] = sink.rows()
		const stored = (row as { attributes: Record<string, string> }).attributes
		expect((row as { message: string }).message).toHaveLength(1024)
		// Truncated keys collide, so at most 32 survive, each key 64 bytes and value 1024.
		expect(Rec.keys(stored).length).toBeLessThanOrEqual(32)
		expect(Arr.every(Rec.keys(stored), (k) => k.length === 64)).toBe(true)
		expect(Arr.every(Rec.values(stored), (v) => v.length === 1024)).toBe(true)
	})
})

describe("POST /v1/sessionReplays/blob", () => {
	const chunkHeaders = (overrides: Record<string, string> = {}) =>
		new Headers({
			"x-maple-session-id": "sess_1",
			"x-maple-chunk-seq": "3",
			"x-maple-is-checkpoint": "1",
			"x-maple-event-count": "2",
			"x-maple-duration-ms": "1500",
			...overrides,
		})
	const events = JSON.stringify([
		{ type: 4, timestamp: 1, data: {} },
		{ type: 2, timestamp: 2, data: {} },
	])

	it("stores the inflated chunk inline with its header metadata", async () => {
		const sink = recorder()
		const result = await run(
			ingestSessionBlob(sink.inserts, chunkHeaders(), gzipSync(new TextEncoder().encode(events))),
		)
		expect(result.response.status).toBe(200)
		expect(sink.batches[0]?.datasource).toBe("session_replay_events")
		const [row] = sink.rows()
		expect(row).toMatchObject({
			session_id: "sess_1",
			chunk_seq: 3,
			is_checkpoint: 1,
			event_count: 2,
			duration_ms: 1500,
			byte_size: new TextEncoder().encode(events).length,
			events,
		})
		expect((row as { timestamp: string }).timestamp).toMatch(
			/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{9}$/,
		)
	})

	it("rejects a missing or unsafe session id and a bad chunk seq", async () => {
		const sink = recorder()
		const body = gzipSync(new TextEncoder().encode(events))
		const statuses = await Promise.all(
			Arr.map(
				[
					chunkHeaders({ "x-maple-session-id": "" }),
					chunkHeaders({ "x-maple-session-id": "../etc" }),
					chunkHeaders({ "x-maple-chunk-seq": "-1" }),
				],
				async (headers) =>
					(await run(ingestSessionBlob(sink.inserts, headers, body))).response.status,
			),
		)
		expect(statuses).toEqual([400, 400, 400])
		expect(sink.batches).toEqual([])
	})

	it("refuses a chunk that inflates past the cap with 413", async () => {
		const sink = recorder()
		const bomb = gzipSync(new Uint8Array(MAX_REPLAY_CHUNK_BYTES + 1))
		const result = await run(ingestSessionBlob(sink.inserts, chunkHeaders(), bomb))
		expect(result.response.status).toBe(413)
		expect(sink.batches).toEqual([])
	})

	it("rejects a body that is not gzip", async () => {
		const result = await run(
			ingestSessionBlob(recorder().inserts, chunkHeaders(), new TextEncoder().encode(events)),
		)
		expect(result.response.status).toBe(400)
	})

	it("answers 500 when the insert fails", async () => {
		const failing = {
			insert: () =>
				Effect.fail(
					new LocalInsertError({
						message: "boom",
						datasource: "session_replay_events",
						accepted: 0,
						cause: "disk full",
					}),
				),
		}
		const result = await run(
			ingestSessionBlob(failing, chunkHeaders(), gzipSync(new TextEncoder().encode(events))),
		)
		expect(result.response.status).toBe(500)
	})
})

describe("session datasources", () => {
	it("have a typed projection for every input column", () => {
		for (const datasource of ["session_replays", "session_replay_events", "session_events"]) {
			const columns = sessionColumns(datasource)
			expect(columns.length).toBeGreaterThan(0)
			expect(Arr.filter(columns, (c) => c.type === undefined)).toEqual([])
		}
	})
})
