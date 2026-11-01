import { OrgId } from "@maple/domain"
import { Result, Schema } from "effect"
import { expect as expectView, given, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import type { HtmlBuilder } from "foldkit/html"
import { Lazy } from "foldkit/test"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "../../../data/load-failure"
import type { PageContext } from "../../contract"
import {
	FetchDetail,
	FetchManifest,
	FetchRange,
	FetchTraceSummaries,
	FetchTranscript,
	MountEngine,
	isFigureFullscreen,
	WatchPlayerKeys,
} from "./command"
import { cacheRange, RANGE_CACHE_LIMIT, seedEvents, seedShiftMs } from "./loader"
import { Message } from "./message"
import type { EventRow, Manifest, Model, ReplayDetail } from "./model"
import { init, update } from "./update"
import { playerStatus } from "./derive"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const SESSION = "a11ce5e55100c0ffee00000000000001"

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const session: ReplayDetail = {
	sessionId: SESSION,
	startTime: "2026-10-01 11:18:00",
	durationMs: 240_000,
	status: "ended",
	lastActivityAt: "2026-10-01 11:22:00",
	userId: "user_maria",
	userName: "Maria Garcia",
	userEmail: "maria@example.test",
	groupId: "",
	groupName: "",
	visitorId: "",
	utmSource: "",
	entryPath: "/",
	urlInitial: "https://shop.acme.test/",
	browserName: "Chrome",
	osName: "macOS",
	deviceType: "desktop",
	country: "US",
	serviceName: "storefront",
	pageViews: 4,
	clickCount: 11,
	errorCount: 1,
	visitorIsNew: false,
	userTraits: "{}",
	referrerHost: "",
	utmMedium: "",
	utmCampaign: "",
	exitPath: "/checkout",
	userAgent: "",
	traceIds: [],
	resourceAttributes: "{}",
	activeTimeMs: null,
	idleTimeMs: null,
}

const chunk = (seq: number, isCheckpoint: boolean) => ({
	chunk_seq: seq,
	timestamp: `2026-10-01T11:18:0${seq}.000Z`,
	duration_ms: 1000,
	event_count: 2,
	byte_size: 1000,
	is_checkpoint: isCheckpoint,
})

const manifest: Manifest = {
	chunks: [chunk(0, true), chunk(1, false)],
	maxBytesPerRequest: 6_000_000,
	maxChunksPerRequest: 16,
}

const event = (type: string, message: string): EventRow => ({
	timestamp: "2026-10-01 11:18:01",
	type,
	url: "",
	traceId: null,
	level: "",
	message,
	targetSelector: "",
	targetText: "",
	netMethod: "",
	netUrl: "",
	netStatus: 0,
	netDurationMs: 0,
	errorStack: "",
})

const entered = () => init({ sessionId: SESSION, search: {} }, context)

const loaded = (): Model => {
	const start = entered().model
	return [
		Message.CompletedFetchDetail({ key: start.detail.key ?? "", result: Result.succeed(session) }),
		Message.CompletedFetchManifest({ key: start.manifest.key ?? "", result: Result.succeed(manifest) }),
		Message.CompletedFetchTranscript({
			key: start.transcript.key ?? "",
			result: Result.succeed([event("custom", "add_to_cart"), event("error", "PaymentError: declined")]),
		}),
	].reduce((model, message) => pageUpdate(model, message).model, start)
}

const seeded = (): Model => {
	const model = loaded()
	const rows = [
		{ chunk_seq: 0, events: [{ type: 4, timestamp: 1, data: { width: 1280, height: 720, href: "https://shop.acme.test/" } }] },
		{ chunk_seq: 1, events: [{ type: 2, timestamp: 2, data: {} }] },
	]
	return pageUpdate(model, Message.CompletedFetchRange({ key: model.loader.range.key ?? "", result: Result.succeed(rows) })).model
}

const mounted = [
	Mount.resolve(WatchPlayerKeys, Message.ChangedFullscreen({ isFullscreen: false })),
	Mount.resolve(MountEngine, Message.ReadiedEngine({ seedVersion: 1, totalMs: 1000 })),
] as const

describe("replay detail", () => {
	test("entry asks for the session, its manifest and its transcript", () => {
		expect(names(entered().commands)).toEqual(
			expect.arrayContaining(["ResolveReplayClock", FetchDetail.name, FetchManifest.name, FetchTranscript.name]),
		)
	})

	test("Try again on a failed session asks for the session again", () => {
		const start = entered().model
		const failed = pageUpdate(
			start,
			Message.CompletedFetchDetail({ key: start.detail.key ?? "", result: Result.fail(toLoadFailure(new Error("down"))) }),
		).model
		expect(names(pageUpdate(failed, Message.ClickedRetryDetail()).commands)).toContain(FetchDetail.name)
	})

	test("a loaded session subscribes to 0–0, then the planned opening range, and its traces", () => {
		const start = entered().model
		const detailed = pageUpdate(start, Message.CompletedFetchDetail({ key: start.detail.key ?? "", result: Result.succeed(session) }))
		expect(names(detailed.commands)).toEqual(expect.arrayContaining([FetchRange.name, FetchTraceSummaries.name]))
		const planned = pageUpdate(
			detailed.model,
			Message.CompletedFetchManifest({ key: start.manifest.key ?? "", result: Result.succeed(manifest) }),
		)
		expect(names(planned.commands)).toEqual([FetchRange.name])
		expect(planned.model.loader.queue).toEqual([{ fromChunkSeq: 0, toChunkSeq: 1 }])
	})

	test("trace summaries read the session's own span with slack, not the day-wide `t` window", () => {
		const start = init({ sessionId: SESSION, search: { t: "2026-10-01 11:18:00" } }, context).model
		const traced = { ...session, traceIds: ["0af7651916cd43dd8448eb211c80319c"] }
		const detailed = pageUpdate(start, Message.CompletedFetchDetail({ key: start.detail.key ?? "", result: Result.succeed(traced) }))
		const summaries = detailed.commands?.find((command) => command.name === FetchTraceSummaries.name)
		expect(summaries?.args).toMatchObject({ windowStart: "2026-10-01 11:03:00", windowEnd: "2026-10-01 11:37:00" })
	})

	test("the opening range becomes the seed, and an answer for a superseded range is dropped", () => {
		const model = loaded()
		const stale = pageUpdate(model, Message.CompletedFetchRange({ key: "stale", result: Result.succeed([]) }))
		expect(stale.model.loader.seedCount).toBe(0)
		expect(seeded().loader.seedCount).toBe(1)
		expect(seeded().loader.seedVersion).toBe(1)
	})

	test("play, pause and a finished replay instruct the engine with fresh nonces", () => {
		const ready = pageUpdate(seeded(), Message.ReadiedEngine({ seedVersion: 1, totalMs: 1000 })).model
		const playing = pageUpdate(ready, Message.ClickedPlay()).model
		expect(playing.player.isPlaying).toBe(true)
		expect(playing.player.control).toBe("1|resume|")
		const paused = pageUpdate(playing, Message.ClickedPlay()).model
		expect(paused.player.control).toBe("2|pause|")
		const finished = pageUpdate(paused, Message.FinishedEngine({ seedVersion: 1 })).model
		expect(pageUpdate(finished, Message.ClickedPlay()).model.player.control).toBe("3|replay|")
	})

	test("the rail filters events by kind and switches to the session tab", () => {
		scene(
			{ update: pageUpdate, view },
			given(seeded()),
			...mounted,
			expectView(text("add_to_cart")).toExist(),
			expectView(role("button", { name: "Errors (1)" })).toExist(),
		)
		const filtered = pageUpdate(seeded(), Message.PickedEventFilter({ filter: "error" })).model
		scene(
			{ update: pageUpdate, view },
			given(filtered),
			...mounted,
			expectView(text("add_to_cart")).not.toExist(),
			expectView(text("PaymentError: declined")).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(pageUpdate(seeded(), Message.PickedRailTab({ tab: "session" })).model),
			...mounted,
			expectView(text("Maria Garcia")).toExist(),
			expectView(text("on the page")).toExist(),
		)
	})

	test("a trace whose spans failed asks again when it is reopened; loaded spans are kept", () => {
		const traceId = "0af7651916cd43dd8448eb211c80319c"
		const toggle = Message.ToggledTraceSpans({ traceId, startTime: "2026-10-01 12:00:00" })
		const opened = pageUpdate(loaded(), toggle)
		expect(names(opened.commands)).toEqual(["FetchReplayTraceSpans"])
		const failed = pageUpdate(
			opened.model,
			Message.CompletedFetchSpans({ traceId, result: Result.fail(toLoadFailure(new Error("down"))) }),
		).model
		const reopened = pageUpdate(pageUpdate(failed, toggle).model, toggle)
		expect(names(reopened.commands)).toEqual(["FetchReplayTraceSpans"])
		const succeeded = pageUpdate(reopened.model, Message.CompletedFetchSpans({ traceId, result: Result.succeed([]) })).model
		expect(names(pageUpdate(pageUpdate(succeeded, toggle).model, toggle).commands)).toEqual([])
	})

	test("fullscreen counts the figure ToggleFullscreen fullscreens, not the studio", () => {
		const element = (attribute: string) => ({ hasAttribute: (name: string) => name === attribute })
		expect(isFigureFullscreen(element("data-replay-figure"))).toBe(true)
		expect(isFigureFullscreen(element("data-replay-studio"))).toBe(false)
		expect(isFigureFullscreen(null)).toBe(false)
	})

	test("the scrubber spans the whole recording, not just the loaded seed", () => {
		const ready = pageUpdate(seeded(), Message.ReadiedEngine({ seedVersion: 1, totalMs: 1000 })).model
		expect(ready.player.totalMs).toBe(2000)
	})

	test("a seek past the loaded window plays the later checkpoint at its place in the recording", () => {
		const at = (seconds: number) => new Date(Date.UTC(2026, 9, 1, 11, 18, 0) + seconds * 1000)
		const big = (seq: number, seconds: number, isCheckpoint: boolean, bytes: number) => ({
			chunk_seq: seq,
			timestamp: at(seconds).toISOString(),
			duration_ms: 1000,
			event_count: 2,
			byte_size: bytes,
			is_checkpoint: isCheckpoint,
		})
		const long: Manifest = {
			chunks: [big(0, 0, true, 4_000_000), big(1, 10, false, 3_000_000), big(2, 300, true, 4_000_000), big(3, 301, false, 1_000)],
			maxBytesPerRequest: 6_000_000,
			maxChunksPerRequest: 16,
		}
		const page = (seconds: number) => ({ type: 4, timestamp: at(seconds).getTime(), data: { width: 1280, height: 720, href: "https://shop.acme.test/" } })
		const snapshot = (seconds: number) => ({ type: 2, timestamp: at(seconds).getTime() + 1, data: {} })
		const click = (seconds: number) => ({ type: 3, timestamp: at(seconds).getTime(), data: { source: 2, type: 2 } })
		const answer = (model: Model, rows: ReadonlyArray<{ chunk_seq: number; events: ReadonlyArray<unknown> }>) =>
			pageUpdate(model, Message.CompletedFetchRange({ key: model.loader.range.key ?? "", result: Result.succeed(rows) })).model

		const start = entered().model
		const opened = [
			Message.CompletedFetchDetail({ key: start.detail.key ?? "", result: Result.succeed(session) }),
			Message.CompletedFetchManifest({ key: start.manifest.key ?? "", result: Result.succeed(long) }),
		].reduce((model, message) => pageUpdate(model, message).model, start)
		const seeded = answer(opened, [{ chunk_seq: 0, events: [page(0), snapshot(0), click(1)] }])
		const ready = pageUpdate(seeded, Message.ReadiedEngine({ seedVersion: seeded.loader.seedVersion, totalMs: 1000 })).model
		expect(seedShiftMs(ready.loader)).toBe(0)

		const seeking = pageUpdate(ready, Message.RequestedSeek({ offsetMs: 302_000 })).model
		const rebuilt = answer(seeking, [
			{ chunk_seq: 2, events: [page(300), snapshot(300)] },
			{ chunk_seq: 3, events: [click(305)] },
		])
		expect(seedShiftMs(rebuilt.loader)).toBe(300_000)
		expect(rebuilt.loader.seekTargetMs).toBe(302_000)
		// The clicks before the seek stay marked, and the new window's land at their real offsets.
		expect(rebuilt.meta.actionMarkers.map((marker) => marker.ms)).toEqual([1_000, 305_000])
	})

	const spread = (sizes: ReadonlyArray<{ seconds: number; bytes: number; isCheckpoint: boolean }>): Manifest => ({
		chunks: sizes.map((chunk, seq) => ({
			chunk_seq: seq,
			timestamp: new Date(Date.UTC(2026, 9, 1, 11, 18, 0) + chunk.seconds * 1000).toISOString(),
			duration_ms: 10_000,
			event_count: 2,
			byte_size: chunk.bytes,
			is_checkpoint: chunk.isCheckpoint,
		})),
		maxBytesPerRequest: 6_000_000,
		maxChunksPerRequest: 16,
	})
	const epochAt = (seconds: number) => Date.UTC(2026, 9, 1, 11, 18, 0) + seconds * 1000
	const chunkRows = (seq: number, seconds: number) => [
		{ chunk_seq: seq, events: [{ type: 4, timestamp: epochAt(seconds), data: {} }, { type: 3, timestamp: epochAt(seconds) + 5, data: { source: 2, type: 2 } }] },
	]
	const openWith = (manifest: Manifest): Model => {
		const start = entered().model
		return [
			Message.CompletedFetchDetail({ key: start.detail.key ?? "", result: Result.succeed(session) }),
			Message.CompletedFetchManifest({ key: start.manifest.key ?? "", result: Result.succeed(manifest) }),
		].reduce((model, message) => pageUpdate(model, message).model, start)
	}
	const answerWith = (model: Model, rows: ReturnType<typeof chunkRows>) =>
		pageUpdate(model, Message.CompletedFetchRange({ key: model.loader.range.key ?? "", result: Result.succeed(rows) }))

	test("the whole recording downloads after the opening window, without waiting for playback", () => {
		const manifest = spread([
			{ seconds: 0, bytes: 4_000_000, isCheckpoint: true },
			{ seconds: 60, bytes: 4_000_000, isCheckpoint: false },
			{ seconds: 120, bytes: 4_000_000, isCheckpoint: false },
		])
		const seeded = answerWith(openWith(manifest), chunkRows(0, 0))
		expect(names(seeded.commands)).toEqual([FetchRange.name])
		const second = answerWith(seeded.model, chunkRows(1, 60))
		expect(names(second.commands)).toEqual([FetchRange.name])
		const done = answerWith(second.model, chunkRows(2, 120)).model
		expect(done.loader.loaded.map((entry) => entry.range.fromChunkSeq)).toEqual([0, 1, 2])
		expect(done.loader.queue).toEqual([])
		expect(done.meta.actionMarkers.map((marker) => marker.ms)).toEqual([5, 60_005, 120_005])
	})

	test("past the memory cap the rest downloads for its markers, and the window slides at its end", () => {
		const manifest = spread([
			{ seconds: 0, bytes: 30_000_000, isCheckpoint: true },
			{ seconds: 60, bytes: 30_000_000, isCheckpoint: true },
			{ seconds: 120, bytes: 1_000, isCheckpoint: false },
		])
		const seeded = answerWith(openWith(manifest), chunkRows(0, 0)).model
		const metaOnly = answerWith(seeded, chunkRows(1, 60)).model
		const done = answerWith(metaOnly, chunkRows(2, 120)).model
		expect(done.loader.loaded.map((entry) => entry.range.fromChunkSeq)).toEqual([0])
		expect(done.meta.actionMarkers.map((marker) => marker.ms)).toEqual([5, 60_005, 120_005])

		const playing = pageUpdate(pageUpdate(done, Message.ReadiedEngine({ seedVersion: done.loader.seedVersion, totalMs: 1 })).model, Message.ClickedPlay()).model
		// Ticks well inside the window do not slide it; the engine running dry there does.
		const early = pageUpdate(playing, Message.TickedEngine({ seedVersion: playing.loader.seedVersion, currentMs: 5_000 })).model
		expect(early.loader.loaded.map((entry) => entry.range.fromChunkSeq)).toEqual([0])
		const dry = pageUpdate(playing, Message.StarvedEngine({ seedVersion: playing.loader.seedVersion, currentMs: 5_000 })).model
		expect(dry.loader.queue).toEqual([{ fromChunkSeq: 1, toChunkSeq: 1 }])
		const slid = pageUpdate(playing, Message.TickedEngine({ seedVersion: playing.loader.seedVersion, currentMs: 9_500 })).model
		// Chunk 1 was fetched for its markers only and not kept, so the new window fetches it again.
		expect(slid.loader.queue).toEqual([{ fromChunkSeq: 1, toChunkSeq: 1 }])
		// The window being left is not cached past the cap either.
		expect(Object.keys(slid.loader.rangeCache)).toEqual([])
		const rebuilt = answerWith(answerWith(slid, chunkRows(1, 60)).model, chunkRows(2, 120)).model
		expect(rebuilt.loader.loaded.map((entry) => entry.range.fromChunkSeq)).toEqual([1, 2])
		const resumed = pageUpdate(rebuilt, Message.ReadiedEngine({ seedVersion: rebuilt.loader.seedVersion, totalMs: 1 })).model
		expect(resumed.player.isPlaying).toBe(true)
		expect(resumed.player.control).toContain("|play|9500")
	})

	test("past the cap with no later checkpoint to slide to, the window keeps growing instead of freezing", () => {
		const manifest = spread([
			{ seconds: 0, bytes: 30_000_000, isCheckpoint: true },
			{ seconds: 60, bytes: 30_000_000, isCheckpoint: false },
			{ seconds: 120, bytes: 1_000, isCheckpoint: false },
		])
		const seeded = answerWith(openWith(manifest), chunkRows(0, 0)).model
		const done = answerWith(answerWith(seeded, chunkRows(1, 60)).model, chunkRows(2, 120)).model
		expect(done.loader.loaded.map((entry) => entry.range.fromChunkSeq)).toEqual([0, 1, 2])
	})

	test("a seek ahead of the download still fills in the markers it jumped over", () => {
		const manifest = spread([
			{ seconds: 0, bytes: 4_000_000, isCheckpoint: true },
			{ seconds: 60, bytes: 4_000_000, isCheckpoint: false },
			{ seconds: 120, bytes: 4_000_000, isCheckpoint: true },
			{ seconds: 180, bytes: 4_000_000, isCheckpoint: false },
		])
		const seeded = answerWith(openWith(manifest), chunkRows(0, 0)).model
		const ready = pageUpdate(seeded, Message.ReadiedEngine({ seedVersion: seeded.loader.seedVersion, totalMs: 1 })).model
		// Chunk 1 is in flight when the seek lands on chunk 2; its answer is superseded.
		const seeking = pageUpdate(ready, Message.RequestedSeek({ offsetMs: 125_000 })).model
		const rebuilt = answerWith(seeking, chunkRows(2, 120)).model
		const ahead = answerWith(rebuilt, chunkRows(3, 180)).model
		expect(ahead.loader.queue).toEqual([{ fromChunkSeq: 1, toChunkSeq: 1 }])
		const filled = answerWith(ahead, chunkRows(1, 60)).model
		expect(filled.meta.actionMarkers.map((marker) => marker.ms)).toEqual([5, 60_005, 120_005, 180_005])
	})

	test("a chunk missing right at a range boundary does not stop the next range from playing", () => {
		const base = spread([
			{ seconds: 0, bytes: 4_000_000, isCheckpoint: true },
			{ seconds: 60, bytes: 4_000_000, isCheckpoint: false },
			{ seconds: 180, bytes: 4_000_000, isCheckpoint: false },
		])
		// Chunk 2 never arrived: ranges are 0, 1 and 3.
		const manifest: Manifest = { ...base, chunks: base.chunks.map((chunk) => (chunk.chunk_seq === 2 ? { ...chunk, chunk_seq: 3 } : chunk)) }
		const seeded = answerWith(openWith(manifest), chunkRows(0, 0)).model
		const second = answerWith(seeded, chunkRows(1, 60)).model
		const done = answerWith(second, chunkRows(3, 180)).model
		expect(done.loader.loaded.map((entry) => entry.range.fromChunkSeq)).toEqual([0, 1, 3])
	})

	test("a failed background range is skipped, and only errors once the playhead reaches it", () => {
		const manifest = spread([
			{ seconds: 0, bytes: 4_000_000, isCheckpoint: true },
			{ seconds: 60, bytes: 4_000_000, isCheckpoint: false },
			{ seconds: 120, bytes: 4_000_000, isCheckpoint: false },
		])
		const seeded = answerWith(openWith(manifest), chunkRows(0, 0)).model
		const failed = pageUpdate(
			seeded,
			Message.CompletedFetchRange({ key: seeded.loader.range.key ?? "", result: Result.fail(toLoadFailure(new Error("down"))) }),
		)
		expect(failed.model.loader.queue).toEqual([{ fromChunkSeq: 2, toChunkSeq: 2 }])
		expect(names(failed.commands)).toEqual([FetchRange.name])
		const rest = answerWith(failed.model, chunkRows(2, 120)).model
		expect(playerStatus(rest, session).status).toBe("ready")

		const ready = pageUpdate(rest, Message.ReadiedEngine({ seedVersion: rest.loader.seedVersion, totalMs: 1 })).model
		const inside = pageUpdate(ready, Message.TickedEngine({ seedVersion: ready.loader.seedVersion, currentMs: 5_000 })).model
		expect(playerStatus(inside, session).status).toBe("ready")
		// The engine running dry before the manifest's estimate of the window end counts as reaching it.
		const dry = pageUpdate(inside, Message.StarvedEngine({ seedVersion: ready.loader.seedVersion, currentMs: 5_000 })).model
		expect(playerStatus(dry, session).status).toBe("error")
		const atEdge = pageUpdate(ready, Message.TickedEngine({ seedVersion: ready.loader.seedVersion, currentMs: 9_500 })).model
		expect(playerStatus(atEdge, session).status).toBe("error")
		const retried = pageUpdate(atEdge, Message.ClickedRetryPlayer())
		expect(names(retried.commands)).toContain(FetchRange.name)
		expect(playerStatus(retried.model, session).status).not.toBe("error")
	})

	test("the seed is cut once per seed version, not re-flattened on every engine tick", () => {
		const ready = pageUpdate(seeded(), Message.ReadiedEngine({ seedVersion: 1, totalMs: 1000 })).model
		const ticked = pageUpdate(ready, Message.TickedEngine({ seedVersion: 1, currentMs: 100 })).model
		const again = pageUpdate(ticked, Message.TickedEngine({ seedVersion: 1, currentMs: 200 })).model
		expect(seedEvents(again.loader)).toHaveLength(2)
		expect(seedEvents(again.loader)).toBe(seedEvents(ready.loader))
	})

	test("a failed range is not asked again on engine ticks, only on retry", () => {
		const model = loaded()
		const failed = pageUpdate(
			model,
			Message.CompletedFetchRange({ key: model.loader.range.key ?? "", result: Result.fail(toLoadFailure(new Error("down"))) }),
		).model
		const ticked = pageUpdate(failed, Message.TickedEngine({ seedVersion: 0, currentMs: 100 }))
		expect(names(ticked.commands)).toEqual([])
		expect(ticked.model.loader.range.data._tag).toBe("Failure")
		const retried = pageUpdate(ticked.model, Message.ClickedRetryPlayer())
		expect(names(retried.commands)).toContain(FetchRange.name)
	})

	test("the range cache keeps the newest answers and evicts the oldest", () => {
		const cache = Array.from({ length: RANGE_CACHE_LIMIT + 3 }, (_, i) => `range-${i}`).reduce(
			(acc, key) => cacheRange(acc, key, []),
			cacheRange({}, "range-0", []),
		)
		expect(Object.keys(cache)).toHaveLength(RANGE_CACHE_LIMIT)
		expect(Object.keys(cache)[0]).toBe("range-3")
		expect(Object.keys(cacheRange(cache, "range-3", [])).at(-1)).toBe("range-3")
	})
})

describe("replay detail playback", () => {
	test("an engine tick reuses every memoized section, so only the playhead is rebuilt", () => {
		const ready = pageUpdate(seeded(), Message.ReadiedEngine({ seedVersion: 1, totalMs: 1000 })).model
		const playing = pageUpdate(ready, Message.ClickedPlay()).model
		const ticked = pageUpdate(playing, Message.TickedEngine({ seedVersion: 1, currentMs: 1500 })).model
		expect(ticked.player.currentMs).not.toBe(playing.player.currentMs)
		// The first render draws the frame before the tick, the second the tick itself.
		const frames = [playing, ticked].values()
		Lazy.expectAllReused({
			view: (model: Model, h: HtmlBuilder<Message>) => view(frames.next().value ?? model, h),
			model: ticked,
		})
	})
})
