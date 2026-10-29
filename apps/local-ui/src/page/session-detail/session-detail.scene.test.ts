import { DateTime, Option } from "effect"
import {
	click,
	expect as expectView,
	expectOutMessage,
	given,
	role,
	scene,
	text,
	withViewInputs,
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { type PageContext, PageOutMessage } from "../contract"
import { SessionDetailBlock } from "./block"
import { FetchDetail, FetchTraces, FetchTranscript, ReadClock } from "./command"
import { Message } from "./message"
import type { Model, SessionDetail } from "./model"
import { init, update } from "./update"
import { view as pageView, type SessionDetailViewInputs } from "./view"

const NOW = Date.UTC(2026, 9, 1, 12, 0, 0)
const env = { apiBase: "", port: "4318", otlpEndpoint: "http://127.0.0.1:4318", isHosted: false }
const context: PageContext = {
	env,
	location: { path: "/sessions/sess-1", search: "range=1h&spanId=abc" },
	rememberedRange: "1h",
	timeFormat: { locale: "en-US", timeZone: "UTC" },
	canGoBack: false,
}
const inputs: SessionDetailViewInputs = { context, clockMs: 0, lastIngestAtMs: Option.none() }
/** Every Message the page's graph accepts: its own and the copy button's generated delivery. */
type PageMessage = typeof SessionDetailBlock.Message.Type
const pageUpdate = (model: Model, message: PageMessage) => update(model, message, context)
const view = withViewInputs(pageView, inputs)()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const session = (traceIds: ReadonlyArray<string>): SessionDetail => ({
	sessionId: "sess-1",
	startTime: DateTime.makeUnsafe(NOW - 60_000),
	durationMs: 30_000,
	status: "ended",
	lastActivityAt: null,
	userId: "",
	userName: "Ada",
	userEmail: "",
	urlInitial: "https://shop.test/",
	userAgent: "Mozilla/5.0",
	browserName: "Chrome",
	osName: "macOS",
	deviceType: "desktop",
	serviceName: "storefront",
	pageViews: 3,
	clickCount: 5,
	errorCount: 0,
	traceIds,
})

describe("local session detail", () => {
	test("entry asks for the session and its transcript at once", () => {
		expect(names(init(context, "sess-1").commands)).toEqual(
			expect.arrayContaining([ReadClock.name, FetchDetail.name, FetchTranscript.name]),
		)
	})

	test("a found session with traces asks for their summaries; an answer for another key is dropped", () => {
		const model = init(context, "sess-1").model
		const stale = pageUpdate(
			model,
			Message.SucceededFetchDetail({ key: "session:other", detail: session(["t1"]), fetchedAtMs: NOW }),
		)
		expect(stale.model.detail).toEqual(model.detail)
		expect(stale.model.detailUpdatedAtMs).toBe(model.detailUpdatedAtMs)
		expect(names(stale.commands)).not.toContain(FetchTraces.name)
		const found = pageUpdate(
			model,
			Message.SucceededFetchDetail({
				key: model.detail.key ?? "",
				detail: session(["t1"]),
				fetchedAtMs: NOW,
			}),
		)
		expect(names(found.commands)).toEqual([FetchTraces.name])
	})

	test("a missing session says so, and Back opens the list without the detail-only params", () => {
		const model = init(context, "sess-1").model
		const missing = pageUpdate(
			model,
			Message.SucceededFetchDetail({ key: model.detail.key ?? "", detail: null, fetchedAtMs: NOW }),
		)
		scene(
			{ update: pageUpdate, view },
			given(missing.model),
			expectView(text("Session not found.")).toExist(),
			click(role("button", { name: "Sessions" })),
			expectOutMessage(PageOutMessage.RequestedBack({ fallbackHash: "#/sessions?range=1h" })),
		)
	})

	test("the start time reads the root's newer clock, as legacy reads the time at each render", () => {
		const opened = pageUpdate(
			init(context, "sess-1").model,
			Message.CompletedReadClock({ nowMs: NOW }),
		).model
		const found = pageUpdate(
			opened,
			Message.SucceededFetchDetail({
				key: opened.detail.key ?? "",
				detail: session([]),
				fetchedAtMs: NOW,
			}),
		).model
		const later = withViewInputs(pageView, { ...inputs, clockMs: NOW + 20 * 60_000 })()
		scene({ update: pageUpdate, view: later }, given(found), expectView(text("21m ago")).toExist())
	})
})
