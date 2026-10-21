import { OrgId } from "@maple/domain"
import { Result, Schema } from "effect"
import { expect as expectView, given, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
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

	test("a loaded session subscribes to 0–0, then the planned opening range, and its traces", () => {
		const start = entered().model
		const detailed = pageUpdate(start, Message.CompletedFetchDetail({ key: start.detail.key ?? "", result: Result.succeed(session) }))
		expect(names(detailed.commands)).toEqual([FetchRange.name, FetchTraceSummaries.name])
		const planned = pageUpdate(
			detailed.model,
			Message.CompletedFetchManifest({ key: start.manifest.key ?? "", result: Result.succeed(manifest) }),
		)
		expect(names(planned.commands)).toEqual([FetchRange.name])
		expect(planned.model.loader.queue).toEqual([{ fromChunkSeq: 0, toChunkSeq: 1 }])
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

		const seeking = pageUpdate(ready, Message.RequestedSeek({ displayMs: 302_000 })).model
		const rebuilt = answer(seeking, [
			{ chunk_seq: 2, events: [page(300), snapshot(300)] },
			{ chunk_seq: 3, events: [click(305)] },
		])
		expect(seedShiftMs(rebuilt.loader)).toBe(300_000)
		expect(rebuilt.loader.seekTargetMs).toBe(302_000)
		// The clicks before the seek stay marked, and the new window's land at their real offsets.
		expect(rebuilt.meta.actionMarkers.map((marker) => marker.ms)).toEqual([1_000, 305_000])
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
