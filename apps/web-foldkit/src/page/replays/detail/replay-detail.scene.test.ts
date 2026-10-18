import { OrgId } from "@maple/domain"
import { Result, Schema } from "effect"
import { expect as expectView, given, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../../contract"
import {
	FetchDetail,
	FetchManifest,
	FetchRange,
	FetchTraceSummaries,
	FetchTranscript,
	MountEngine,
	WatchPlayerKeys,
} from "./command"
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
		expect(names(entered().commands)).toEqual([
			"ResolveReplayClock",
			FetchDetail.name,
			FetchManifest.name,
			FetchTranscript.name,
		])
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
})
