import { SpanId, TraceId } from "@maple/domain"
import { Effect, Option, Result, Schema, Array as Arr } from "effect"
import {
	click,
	Command,
	expect as expectView,
	given,
	keydown,
	Mount,
	role,
	scene,
	text,
	withViewInputs,
} from "foldkit/scene"
import { inertHtml as ih } from "foldkit/html"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "@maple/views/data/load-failure"
import * as Tabs from "@maple/views/ui/tabs"
import * as ProfileFlamegraph from "../../profiles/profile-flamegraph"
import type { SpanNodeData } from "../trace-data"
import { TraceSource } from "../trace-source"
import { FetchSpanDetail, FetchSpanLogs } from "./command"
import { Message, OutMessage } from "./message"
import type { Model } from "./model"
import { init, PROFILE_SPAN_CAP, refresh, subtreeIsCut, tabsOver, update } from "./update"
import { view as panelView } from "./view"

const span: SpanNodeData = {
	traceId: Schema.decodeSync(TraceId)("6843a8853182b32339b2dd5120d423f2"),
	spanId: Schema.decodeSync(SpanId)("0f5ad6f96a94c689"),
	parentSpanId: "5649cc1dd6f78f8c",
	spanName: "SELECT shop.payments",
	serviceName: "payment-svc",
	spanKind: "Client",
	durationMs: 4900,
	startTime: "2026-10-01 11:43:32.425",
	statusCode: "Error",
	statusMessage: "timed out acquiring a connection from the pool after 5000ms",
	spanAttributes: { "db.system.name": "postgresql" },
	resourceAttributes: {},
	children: [],
	depth: 3,
}

const input = { span, traceStartTime: "2026-10-01 11:43:32.411", totalDurationMs: 4920 }

const view = withViewInputs(panelView, {
	timeZone: "UTC",
	canFilterAttributes: true,
	logsDocsHref: "https://maple.dev/docs",
})()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)

const detail = { spanAttributes: { "db.system.name": "postgresql" }, resourceAttributes: {}, events: [] }

const loaded = (): Model => {
	const entered = init(input).model
	return Arr.reduce(
		[
			Message.CompletedFetchDetail({ key: entered.detail.key ?? "", result: Result.succeed(detail) }),
			Message.CompletedFetchLogs({ key: entered.logs.key ?? "", result: Result.succeed([]) }),
		],
		entered,
		(model, message) => update(model, message).model,
	)
}

// The tab strip is a Tabs Submodel, so its mount resolves with the Submodel's own Message.
const indicatorMeasured = () =>
	Mount.resolve(
		Tabs.MeasureTabIndicator,
		Tabs.Message.MeasuredIndicator({
			rect: { left: 16, right: 300, top: 4, bottom: 5, width: 96, height: 32 },
		}),
	)

const withInfra = withViewInputs(panelView, {
	timeZone: "UTC",
	canFilterAttributes: false,
	infraTab: () => ih.p([], ["Host charts"]),
})()

const cpuProfile = {
	sampleType: "cpu",
	sampleUnit: "nanoseconds",
	totalValue: 9_000_000,
	stacks: [
		{ frames: ["query", "parse"], files: ["/app/db.js", "/app/sql.js"], lines: [4, 9], value: 9_000_000 },
	],
}

const profiled = (profile: typeof cpuProfile | null = cpuProfile): Model => {
	const model = loaded()
	return update(
		model,
		Message.CompletedFetchProfile({ key: model.profile.key ?? "", result: Result.succeed(profile) }),
	).model
}

/** The strip's tab ids in the order drawn: a focus command must name one of the first `count`. */
const tabIdAt = (index: number): string => Tabs.tabId(init(input).model.tabs, index)
const tab = (name: string) => role("tab", { name: new RegExp(name) })
const focusLands = (name: string, index: number) =>
	[
		Command.expectExact(Tabs.FocusTab({ id: tabIdAt(index) })),
		Command.resolve(Tabs.FocusTab, Tabs.Message.CompletedFocusTab()),
		expectView(tab(name)).toHaveAttr("id", tabIdAt(index)),
		expectView(tab(name)).toHaveAttr("tabindex", "0"),
	] as const

const ALL_TABS = ["Details", "Logs", "Infrastructure", "Profile"]

const SHOWN = [
	{ title: "Details, Logs", view, model: loaded, names: ["Details", "Logs"] },
	{
		title: "Details, Logs, Infrastructure",
		view: withInfra,
		model: loaded,
		names: ["Details", "Logs", "Infrastructure"],
	},
	{ title: "Details, Logs, Profile", view, model: profiled, names: ["Details", "Logs", "Profile"] },
	{
		title: "all four",
		view: withInfra,
		model: profiled,
		names: ["Details", "Logs", "Infrastructure", "Profile"],
	},
] as const

describe("span panel tab keys", () => {
	test.each(SHOWN)("End and Home reach the last and the first shown tab: $title", (shown) => {
		const last = shown.names.length - 1
		scene(
			{ update, view: shown.view },
			given(shown.model()),
			indicatorMeasured(),
			...Arr.map(
				Arr.filter(ALL_TABS, (name) => !Arr.contains(shown.names, name)),
				(name) => expectView(tab(name)).toBeAbsent(),
			),
			keydown(tab("Details"), "End"),
			...focusLands(shown.names[last] ?? "", last),
			keydown(tab(shown.names[last] ?? ""), "Home"),
			...focusLands("Details", 0),
		)
	})

	test.each(SHOWN)("arrows wrap around the shown tabs and never leave them: $title", (shown) => {
		const last = shown.names.length - 1
		scene(
			{ update, view: shown.view },
			given(shown.model()),
			indicatorMeasured(),
			expectView(tab("Details")).toHaveAttr("tabindex", "0"),
			keydown(tab("Details"), "ArrowLeft"),
			...focusLands(shown.names[last] ?? "", last),
			keydown(tab(shown.names[last] ?? ""), "ArrowRight"),
			...focusLands("Details", 0),
			keydown(tab("Details"), "ArrowRight"),
			...focusLands("Logs", 1),
			...(last > 1 ? [keydown(tab("Logs"), "ArrowRight"), ...focusLands(shown.names[2] ?? "", 2)] : []),
		)
	})

	test("clicking Profile with no Infrastructure tab opens the profile", () => {
		const model = profiled()
		scene(
			{ update, view },
			given(model),
			indicatorMeasured(),
			expectView(tab("Infrastructure")).toBeAbsent(),
			click(tab("Profile")),
			Mount.resolve(
				ProfileFlamegraph.MountFlameChart({ chartId: model.flamegraph.id, maxRows: 14 }),
				Message.GotFlamegraphMessage({
					message: ProfileFlamegraph.Message.ChangedZoom({ isZoomed: false }),
				}),
			),
			expectView(tab("Profile")).toHaveAttr("aria-selected", "true"),
			expectView(tab("Profile")).toHaveAttr("tabindex", "0"),
			expectView(role("table", { name: "Top functions" })).toExist(),
			click(tab("Logs")),
			Mount.expectEnded(ProfileFlamegraph.MountFlameChart),
			expectView(tab("Logs")).toHaveAttr("aria-selected", "true"),
			expectView(text("Read the docs")).toExist(),
		)
	})

	test("a failed profile read keeps the Profile tab and says the read failed", () => {
		const model = loaded()
		const failed = update(
			model,
			Message.CompletedFetchProfile({
				key: model.profile.key ?? "",
				result: Result.fail(toLoadFailure(new Error("warehouse unavailable"))),
			}),
		).model
		scene(
			{ update, view },
			given(failed),
			indicatorMeasured(),
			click(tab("Profile")),
			expectView(tab("Profile")).toHaveAttr("aria-selected", "true"),
			expectView(text("Couldn't load the profile")).toExist(),
		)
	})

	test("says when the span has more spans under it than the read covers", () => {
		expect(subtreeIsCut(span)).toBe(false)
		const leaf: SpanNodeData = { ...span, children: [] }
		const wide: SpanNodeData = { ...span, children: Arr.makeBy(PROFILE_SPAN_CAP, () => leaf) }
		expect(subtreeIsCut(wide)).toBe(true)
		expect(subtreeIsCut({ ...wide, children: wide.children.slice(1) })).toBe(false)
	})

	test("a cut subtree with no samples has no Profile tab, as a source without profiles has none", () => {
		const leaf: SpanNodeData = { ...span, children: [] }
		const wide = init({
			...input,
			span: { ...span, children: Arr.makeBy(PROFILE_SPAN_CAP, () => leaf) },
		}).model
		const empty = update(
			wide,
			Message.CompletedFetchProfile({ key: wide.profile.key ?? "", result: Result.succeed(null) }),
		).model
		scene({ update, view }, given(empty), indicatorMeasured(), expectView(tab("Profile")).toBeAbsent())
	})

	test("a highlight left on a tab that went away falls back to the selected tab", () => {
		const onProfile = update(
			profiled(),
			Message.GotTabsMessage({
				message: Tabs.Message.PressedTabKey({ key: "End" }),
				shown: ["details", "logs", "infrastructure", "profile"],
			}),
		).model
		const gone = update(
			onProfile,
			Message.CompletedFetchProfile({ key: onProfile.profile.key ?? "", result: Result.succeed(null) }),
		).model
		scene(
			{ update, view: withInfra },
			given(gone),
			indicatorMeasured(),
			expectView(tab("Profile")).toBeAbsent(),
			expectView(tab("Details")).toHaveAttr("tabindex", "0"),
			keydown(tab("Details"), "End"),
			...focusLands("Infrastructure", 2),
		)
	})

	test("the highlight follows its tab when a tab appears before it", () => {
		const shown = tabsOver(
			{ ...init(input).model.tabs, values: ["details", "logs", "profile"], highlightedIndex: 2 },
			["details", "logs", "infrastructure", "profile"],
		)
		expect(shown.values[shown.highlightedIndex]).toBe("profile")
	})

	test("a selected tab that is no longer shown reads as the first tab", () => {
		const shown = tabsOver({ ...init(input).model.tabs, selected: "profile", highlightedIndex: 3 }, [
			"details",
			"logs",
		])
		expect([shown.selected, shown.highlightedIndex]).toEqual(["details", 0])
	})
})

describe("span panel", () => {
	test("mounting asks for the span's logs and its full attributes", () => {
		expect(names(init(input).commands)).toEqual(
			expect.arrayContaining([FetchSpanLogs.name, FetchSpanDetail.name]),
		)
	})

	test("a span missing from the trace only asks for its logs", () => {
		expect(names(init({ ...input, span: { ...span, isMissing: true } }).commands)).toEqual([
			FetchSpanLogs.name,
		])
	})

	test("an answer for another span is dropped", () => {
		const entered = init(input).model
		const stale = update(
			entered,
			Message.CompletedFetchDetail({ key: "span-detail:other", result: Result.succeed(detail) }),
		)
		expect(stale.model.detail).toEqual(entered.detail)
		const failed = update(
			entered,
			Message.CompletedFetchLogs({
				key: entered.logs.key ?? "",
				result: Result.fail(toLoadFailure("boom")),
			}),
		)
		expect(failed.model.logs.data._tag).toBe("Failure")
	})

	test("close and the parent span link ask the page", () => {
		expect(update(loaded(), Message.ClickedClose()).outMessage).toEqual(OutMessage.Closed())
		expect(
			update(loaded(), Message.ClickedParentSpan({ spanId: "5649cc1dd6f78f8c" })).outMessage,
		).toEqual(OutMessage.SelectedSpanId({ spanId: "5649cc1dd6f78f8c" }))
	})

	test("the details tab shows the span, and the Logs tab its empty logs", () => {
		scene(
			{ update, view },
			given(loaded()),
			indicatorMeasured(),
			expectView(text("Span attributes")).toExist(),
			expectView(role("tab", { name: /Details/ })).toHaveAttr("aria-selected", "true"),
			click(role("tab", { name: /Logs/ })),
			expectView(role("tab", { name: /Logs/ })).toHaveAttr("aria-selected", "true"),
			expectView(text("Read the docs")).toExist(),
		)
	})
	test("a refresh asks the source again past its cache, keeping the loaded data up", () => {
		const refreshed = refresh(loaded())
		expect(names(refreshed.commands)).toEqual(
			expect.arrayContaining([FetchSpanLogs.name, FetchSpanDetail.name]),
		)
		expect(refreshed.model.detail.data._tag).toBe("Refreshing")
	})

	test("a log row and an attribute filter ask the page", () => {
		const log = {
			key: "log-1",
			timestamp: "2026-10-01 11:43:33.000",
			severityText: "ERROR",
			body: "pool exhausted",
		}
		const entered = init(input).model
		const withLogs = update(
			{ ...loaded(), tabs: { ...entered.tabs, selected: "logs" } },
			Message.CompletedFetchLogs({ key: entered.logs.key ?? "", result: Result.succeed([log]) }),
		).model
		scene(
			{ update, view },
			given(withLogs),
			indicatorMeasured(),
			expectView(text("pool exhausted")).toExist(),
		)
		expect(update(withLogs, Message.ClickedLog({ key: "log-1" })).outMessage).toEqual(
			OutMessage.SelectedLog({ key: "log-1" }),
		)
		const filter = { scope: "span", key: "db.system.name", value: "postgresql", isExclude: true } as const
		expect(update(withLogs, Message.ClickedAttributeFilter(filter)).outMessage).toEqual(
			OutMessage.RequestedAttributeFilter(filter),
		)
	})

	test("the Infrastructure tab shows only when the app provides it", () => {
		scene(
			{ update, view },
			given(loaded()),
			indicatorMeasured(),
			expectView(role("tab", { name: /Infrastructure/ })).toBeAbsent(),
		)
		scene(
			{ update, view: withInfra },
			given(loaded()),
			indicatorMeasured(),
			click(role("tab", { name: /Infrastructure/ })),
			expectView(text("Host charts")).toExist(),
		)
	})
	test("a stale cached answer shows at once and is revalidated; a fresh one is kept", () => {
		const entered = init(input)
		const fetch = {
			key: entered.model.detail.key ?? "",
			request: { traceId: span.traceId, spanId: span.spanId, timestamp: span.startTime },
			fallback: { spanAttributes: span.spanAttributes, resourceAttributes: span.resourceAttributes },
		}
		const stale = update(entered.model, Message.FoundCachedDetail({ fetch, detail, isFresh: false }))
		expect([stale.model.detail.data._tag, names(stale.commands)]).toEqual([
			"Refreshing",
			[FetchSpanDetail.name],
		])
		const fresh = update(entered.model, Message.FoundCachedDetail({ fetch, detail, isFresh: true }))
		expect([fresh.model.detail.data._tag, names(fresh.commands)]).toEqual(["Success", []])
	})

	test("a span the source has no row for falls back to the trace's trimmed attributes", async () => {
		const command = Option.getOrUndefined(
			Arr.findFirst(init(input).commands ?? [], ({ name }) => name === FetchSpanDetail.name),
		)
		const source = TraceSource.of({
			spanDetail: () => Effect.succeedNone,
			spanLogs: () => Effect.succeed([]),
		})
		const message = await Effect.runPromise(
			Effect.provideService(command?.effect ?? Effect.never, TraceSource, source),
		)
		expect(message).toEqual(
			Message.CompletedFetchDetail({
				key: init(input).model.detail.key ?? "",
				result: Result.succeed({
					spanAttributes: span.spanAttributes,
					resourceAttributes: {},
					events: [],
				}),
			}),
		)
	})
})
