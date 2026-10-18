import { DateTime, Option } from "effect"
import { click, expect as expectView, expectOutMessage, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { type PageContext, PageOutMessage } from "../contract"
import type { PageViewInputs } from "../kit/inputs"
import { FetchFacets, FetchTraces } from "./command"
import { Message } from "./message"
import type { Model, TraceRow } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

const NOW = Date.parse("2026-10-01T12:00:30Z")

const context: PageContext = {
	env: { apiBase: "", port: "4318", otlpEndpoint: "http://127.0.0.1:4318", isHosted: false },
	location: { path: "/traces", search: "" },
	rememberedRange: "1h",
	timeFormat: { locale: "en-US", timeZone: "UTC" },
	canGoBack: false,
}
const inputs: PageViewInputs = {
	context,
	presenceOf: () => Option.some({ signal: "traces", status: "absent", lastSeenMs: null }),
	presenceNowMs: NOW,
	hasNewDataSince: () => false,
}
const view = withViewInputs(pageView, inputs)()
const pageUpdate = (model: Model, message: Message) => update(model, message, context)

const row = (traceId: string): TraceRow => ({
	traceId,
	startTime: DateTime.makeUnsafe(NOW - 60_000),
	durationMs: 12.5,
	spanCount: 7,
	services: ["storefront"],
	rootSpanName: "GET /",
	rootSpanKind: "Server",
	rootSpanAttributes: {},
	hasError: false,
})

const anchored = () => pageUpdate(init(context).model, Message.CompletedReadClock({ nowMs: NOW }))

const loaded = (rows: ReadonlyArray<TraceRow>) => {
	const base = anchored().model
	return pageUpdate(
		base,
		Message.SucceededFetchTraces({ key: base.traces.key ?? "", data: { pages: [rows], hasNextPage: false }, fetchedAtMs: NOW }),
	)
}

describe("local traces list", () => {
	test("entry reads the clock, then asks for the list and the facets", () => {
		expect(init(context).commands.map(({ name }) => name)).toContain("ReadTracesClock")
		expect((anchored().commands ?? []).map(({ name }) => name)).toEqual([FetchTraces.name, FetchFacets.name])
	})

	test("a new key opens on the cached older window, then fetches its own rows", () => {
		const base = anchored()
		const args = (base.commands ?? []).map(({ args }) => args)
		expect(args[0]).toEqual(expect.objectContaining({ readsCache: true }))
		const cached = { data: { pages: [[row("old")]], hasNextPage: false }, updatedAtMs: NOW - 3_600_000, isStandIn: true, isFresh: false }
		const found = pageUpdate(base.model, Message.FoundCachedTraces({ key: base.model.traces.key ?? "", cached }))
		expect([found.model.traces.isStandIn, found.model.traces.isPlaceholder, found.model.traces.updatedAtMs]).toEqual([true, false, NOW - 3_600_000])
		expect((found.commands ?? []).map(({ name, args }) => [name, args])).toEqual([
			[FetchTraces.name, expect.objectContaining({ readsCache: false, pageCount: 1 })],
		])
		const fetched = pageUpdate(
			found.model,
			Message.SucceededFetchTraces({ key: found.model.traces.key ?? "", data: { pages: [[row("new")]], hasNextPage: false }, fetchedAtMs: NOW }),
		)
		expect([fetched.model.traces.isStandIn, fetched.model.traces.updatedAtMs]).toEqual([false, NOW])
	})

	test("a fresh exact result is shown without a fetch", () => {
		const base = anchored().model
		const cached = { data: { pages: [[row("t")]], hasNextPage: false }, updatedAtMs: NOW - 5_000, isStandIn: false, isFresh: true }
		expect(pageUpdate(base, Message.FoundCachedTraces({ key: base.traces.key ?? "", cached })).commands).toEqual([])
	})

	test("an answer for a superseded key is dropped", () => {
		const base = anchored().model
		const stale = pageUpdate(
			base,
			Message.SucceededFetchTraces({ key: "stale", data: { pages: [[row("a")]], hasNextPage: false }, fetchedAtMs: NOW }),
		)
		expect(stale.model.traces).toEqual(base.traces)
	})

	test("rows render and Has error filters the hash", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded([row("t1")]).model),
			expectView(text("1")).toExist(),
			click(role("checkbox", { name: "Has error" })),
			expectOutMessage(PageOutMessage.RequestedNavigation({ hash: "#/traces?errors=1", isReplace: true })),
		)
	})

	test("an empty list asks for signal presence and renders the on-ramp", () => {
		const result = loaded([])
		expect(result.outMessage).toEqual(PageOutMessage.RequestedSignalPresence())
		scene({ update: pageUpdate, view }, given(result.model), expectView(text("No traces yet")).toExist())
	})
})
