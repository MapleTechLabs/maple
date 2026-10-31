import { OrgId, SpanId, TraceId } from "@maple/domain"
import { Result, Schema } from "effect"
import { expect as expectView, given, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import { Lazy } from "foldkit/test"
import { describe, expect, test } from "vitest"
import * as Dialog from "../../../ui/dialog"
import { MountDialog } from "../../../ui/dialog"
import { PageOutMessage, type PageContext } from "../../contract"
import { Message } from "./message"
import type { Model } from "./model"
import type { SpanNodeData, TraceData } from "./trace-data"
import { init, routeChanged, update } from "./update"
import * as Tabs from "../../../ui/tabs"
import * as SpanPanel from "./span-panel"
import { MeasureSplit } from "./split"
import { MeasureTimelineBody, MountAltToggle } from "./timeline/command"
import { Message as TimelineMessage } from "./timeline/message"
import { breadcrumbs, view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const TRACE = "6843a8853182b32339b2dd5120d423f2"
const traceId = Schema.decodeSync(TraceId)(TRACE)

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const span = (
	id: string,
	name: string,
	children: ReadonlyArray<SpanNodeData>,
	depth: number,
): SpanNodeData => ({
	traceId,
	spanId: Schema.decodeSync(SpanId)(id),
	parentSpanId: "",
	spanName: name,
	serviceName: "storefront",
	spanKind: "Server",
	durationMs: 120,
	startTime: "2026-10-01 11:43:32.411",
	statusCode: depth === 1 ? "Error" : "Ok",
	statusMessage: depth === 1 ? "pool timeout" : "",
	spanAttributes: {},
	resourceAttributes: {},
	children,
	depth,
})

const child = span("0f5ad6f96a94c689", "SELECT shop.payments", [], 1)
const root = span("5649cc1dd6f78f8c", "checkout", [child], 0)
const trace: TraceData = {
	traceId,
	spans: [root, child],
	rootSpans: [root],
	totalDurationMs: 120,
	traceStartTime: "2026-10-01 11:43:32.411",
}

const entered = (search = {}) => init({ traceId: TRACE, search }, context)

const loaded = (search = {}) => {
	const start = entered(search).model
	return pageUpdate(
		start,
		Message.CompletedFetchHierarchy({ key: start.hierarchy.key ?? "", result: Result.succeed(trace) }),
	)
}

describe("trace detail", () => {
	test("entry reads the clock and asks for the span hierarchy", () => {
		expect(names(entered().commands)).toEqual(
			expect.arrayContaining(["ReadTraceDetailClock", "ReadTraceListQuery", "FetchSpanHierarchy"]),
		)
	})

	test("an id that is not a trace id renders not found without a request", () => {
		const invalid = init({ traceId: "  ", search: {} }, context)
		expect(names(invalid.commands)).not.toContain("FetchSpanHierarchy")
		scene(
			{ update: pageUpdate, view },
			given(invalid.model),
			expectView(text("Trace not found")).toExist(),
		)
	})

	test("a loaded trace asks for its events, replays, logs and product events", () => {
		const commands = names(loaded().commands)
		expect(commands).toEqual(
			expect.arrayContaining([
				"FetchTraceSpanEvents",
				"FetchTraceReplays",
				"FetchTraceLogsCount",
				"FetchTraceProductEvents",
			]),
		)
		expect(loaded().model.timeline).not.toBeNull()
	})

	test("a hierarchy answer for a superseded timestamp is dropped", () => {
		const first = entered().model
		const moved = routeChanged(
			first,
			{ traceId: TRACE, search: { t: "2026-10-01T11:43:32Z" } },
			context,
		).model
		const late = pageUpdate(
			moved,
			Message.CompletedFetchHierarchy({
				key: first.hierarchy.key ?? "",
				result: Result.succeed(trace),
			}),
		)
		expect(late.model.timeline).toBeNull()
	})

	test("View span on the error callout selects the failing span, replacing history", () => {
		const selected = pageUpdate(loaded().model, Message.ClickedViewOriginSpan({ spanId: child.spanId }))
		expect(selected.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: `/traces/${TRACE}?spanId=${child.spanId}`,
				isReplace: true,
			}),
		)
		const again = pageUpdate(
			loaded({ spanId: child.spanId }).model,
			Message.ClickedViewOriginSpan({ spanId: child.spanId }),
		)
		expect(again.outMessage).toBeUndefined()
	})

	test("a selected span opens the span panel beside the trace", () => {
		const model = loaded({ spanId: child.spanId }).model
		expect(model.spanPanel).not.toBeNull()
		expect(model.split.layout).toEqual([60, 40])
	})

	const urlOf = (result: { readonly outMessage?: unknown }) =>
		typeof result.outMessage === "object" && result.outMessage !== null && "url" in result.outMessage
			? String(result.outMessage.url)
			: ""

	const withList = (model: Model) =>
		pageUpdate(model, Message.CompletedReadListQuery({ listQuery: "services=api&hasError=true" })).model

	test("the list filters on the URL ride on span navigation and the Traces crumb", () => {
		const model = withList(loaded().model)
		expect(breadcrumbs(model)[0]?.href).toBe("/traces?services=api&hasError=true")
		const selected = pageUpdate(model, Message.ClickedViewOriginSpan({ spanId: child.spanId }))
		expect(urlOf(selected)).toBe(`/traces/${TRACE}?services=api&hasError=true&spanId=${child.spanId}`)
		const invalid = withList(init({ traceId: "  ", search: {} }, context).model)
		scene(
			{ update: pageUpdate, view },
			given(invalid),
			expectView(role("link", { name: "Back to Traces" })).toHaveAttr(
				"href",
				"/traces?services=api&hasError=true",
			),
		)
	})

	test("Escape on the page closes the span panel, replacing history", () => {
		const model = withList(loaded({ spanId: child.spanId }).model)
		expect(pageUpdate(model, Message.PressedPageEscape()).outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: `/traces/${TRACE}?services=api&hasError=true`,
				isReplace: true,
			}),
		)
		expect(pageUpdate(loaded().model, Message.PressedPageEscape()).outMessage).toBeUndefined()
	})

	const RECT = { left: 0, right: 96, top: 0, bottom: 32, width: 96, height: 32 }

	test("below md the span opens in a bottom sheet, which closes the panel when dismissed", () => {
		const model = loaded({ spanId: child.spanId }).model
		scene(
			{ update: pageUpdate, view: withViewInputs(pageView, { context, isMobile: true })() },
			given(model),
			Mount.resolve(MeasureSplit, Message.MeasuredSplitWidth({ width: 390 })),
			// Mounts inside a Submodel resolve with that Submodel's own Message.
			Mount.resolve(MountAltToggle, TimelineMessage.AltClickedToggleCollapse({ spanId: "none" })),
			Mount.resolve(MeasureTimelineBody, TimelineMessage.MeasuredScroller({ width: 390, height: 400 })),
			Mount.resolve(Tabs.MeasureTabIndicator, Tabs.Message.MeasuredIndicator({ rect: RECT })),
			Mount.resolve<string, SpanPanel.Message>(
				Tabs.MeasureTabIndicator,
				SpanPanel.Message.GotTabsMessage({ message: Tabs.Message.MeasuredIndicator({ rect: RECT }) }),
			),
			Mount.resolve(MountDialog, Dialog.Message.CompletedMountDialog()),
			expectView(role("dialog", { name: "Span details" })).toExist(),
		)
		const dismissed = pageUpdate(
			model,
			Message.GotSpanSheetMessage({ message: Dialog.Message.PressedEscape() }),
		)
		expect(urlOf(dismissed)).toBe(`/traces/${TRACE}`)
	})
})

describe("trace detail lazy views", () => {
	test("an unchanged trace reuses its anatomy, callout and flow layers", () => {
		const flow = loaded({ view: "flow" }).model
		expect(flow.flow).not.toBeNull()
		Lazy.expectAllReused({ view, model: flow })
	})
})
