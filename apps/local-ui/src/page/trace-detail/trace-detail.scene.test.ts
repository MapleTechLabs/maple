import { SpanId, TraceId } from "@maple/domain"
import { MeasureTimelineBody, MountAltToggle } from "@maple/web/page/traces/detail/timeline/command"
import { Message as TimelineMessage } from "@maple/web/page/traces/detail/timeline/message"
import type { TraceData } from "@maple/web/page/traces/detail/trace-data"
import * as Tabs from "@maple/web/ui/tabs"
import { Option, Schema } from "effect"
import {
	click,
	Command,
	expect as expectView,
	expectOutMessage,
	given,
	Mount,
	role,
	scene,
	text,
	withViewInputs,
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { type PageContext, PageOutMessage } from "../contract"
import { TraceDetailBlock } from "./block"
import { FetchSpanDetail, FetchSpanLogs, FetchTrace, RelayTabChoice, TrackPointer } from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import { view as pageView, type TraceDetailViewInputs } from "./view"

const TRACE_ID = "0eab694ff33721d5a836ce7444afadcc"
const SPAN_ID = "1111111111111111"
const NOW = Date.parse("2026-10-01T12:00:30Z")

const contextAt = (search: string): PageContext => ({
	env: { apiBase: "", port: "4318", otlpEndpoint: "http://127.0.0.1:4318", isHosted: false },
	location: { path: `/traces/${TRACE_ID}`, search },
	rememberedRange: "1h",
	timeFormat: { locale: "en-US", timeZone: "UTC" },
	canGoBack: false,
})
const context = contextAt("")
const { init, update } = TraceDetailBlock
const inputs: TraceDetailViewInputs = { context, lastIngestAtMs: Option.none() }
const view = withViewInputs(pageView, inputs)()
/** Every Message the page's graph accepts: its own and its children's generated delivery. */
type PageMessage = typeof TraceDetailBlock.Message.Type
const pageUpdate = (model: Model, message: PageMessage) => update(model, message, context)
const locationChanged = (model: Model, ctx: PageContext) =>
	TraceDetailBlock.operations.informLocationChanged(model, ctx)

const span = {
	traceId: Schema.decodeSync(TraceId)(TRACE_ID),
	spanId: Schema.decodeSync(SpanId)(SPAN_ID),
	parentSpanId: "",
	spanName: "GET /",
	serviceName: "storefront",
	spanKind: "Server",
	durationMs: 12,
	startTime: "2026-10-01T11:59:00.000Z",
	statusCode: "Ok",
	statusMessage: "",
	spanAttributes: {},
	resourceAttributes: {},
}

const trace: TraceData = {
	traceId: span.traceId,
	spans: [span],
	rootSpans: [{ ...span, children: [], depth: 0 }],
	totalDurationMs: 12,
	traceStartTime: span.startTime,
}

const rect = { left: 0, right: 80, top: 0, bottom: 24, width: 80, height: 24 }

const entered = init(context, TRACE_ID)
const answered = (model: Model, answer: Option.Option<TraceData>, ctx = context) =>
	update(
		model,
		Message.SucceededFetchTrace({ key: model.trace.key ?? "", trace: answer, fetchedAtMs: NOW }),
		ctx,
	)

describe("local trace detail", () => {
	test("entry asks for the span hierarchy of the trace", () => {
		expect((entered.commands ?? []).map(({ name }) => name)).toEqual([FetchTrace.name])
	})

	test("an answer for a superseded key is dropped", () => {
		const stale = pageUpdate(
			entered.model,
			Message.SucceededFetchTrace({ key: "stale", trace: Option.some(trace), fetchedAtMs: NOW }),
		)
		expect(stale.model.trace).toEqual(entered.model.trace)
		expect(Option.isNone(stale.model.timeline)).toBe(true)
	})

	test("a trace without spans reads as not found", () => {
		scene(
			{ update: pageUpdate, view },
			given(answered(entered.model, Option.none()).model),
			Mount.resolve(TrackPointer, Message.MovedPointer({ x: 10, y: 10 })),
			expectView(text("Trace not found")).toExist(),
		)
	})

	test("the trace mounts the timeline; a hash span opens the panel and loads its logs and attributes", () => {
		const loaded = answered(entered.model, Option.some(trace)).model
		expect(Option.isSome(loaded.timeline)).toBe(true)
		expect(loaded.panel).toBeNull()
		const selected = locationChanged(loaded, contextAt(`spanId=${SPAN_ID}`))
		expect(selected.model.panel?.span.spanId).toBe(SPAN_ID)
		expect((selected.commands ?? []).map(({ name }) => name)).toEqual(
			expect.arrayContaining([FetchSpanLogs.name, FetchSpanDetail.name]),
		)
	})

	test("a tab press asks for its view in the hash and leaves the shown tab to the hash", () => {
		const loaded = answered(entered.model, Option.some(trace)).model
		scene(
			{ update: pageUpdate, view },
			given(loaded),
			Mount.resolve(TrackPointer, Message.MovedPointer({ x: 10, y: 10 })),
			Mount.resolve(Tabs.MeasureTabIndicator, Tabs.Message.MeasuredIndicator({ rect })),
			Mount.resolve(MeasureTimelineBody, TimelineMessage.MeasuredScroller({ width: 900, height: 400 })),
			Mount.resolve(
				MountAltToggle,
				TimelineMessage.AltClickedToggleCollapse({ spanId: "no-such-span" }),
			),
			click(role("tab", { name: "Waterfall" })),
			Command.resolve(RelayTabChoice, Message.ChoseTab({ value: "waterfall" })),
			expectOutMessage(
				PageOutMessage.RequestedNavigation({
					hash: `#/traces/${TRACE_ID}?view=waterfall`,
					isReplace: true,
				}),
			),
			expectView(role("tab", { name: "Timeline" })).toHaveAttr("aria-selected", "true"),
		)
	})

	test("Escape with a panel open drops the span from the hash", () => {
		const ctx = contextAt(`spanId=${SPAN_ID}`)
		const open = answered(init(ctx, TRACE_ID).model, Option.some(trace), ctx).model
		const closed = update(open, Message.PressedEscape(), ctx)
		expect(closed.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({ hash: `#/traces/${TRACE_ID}`, isReplace: true }),
		)
	})

	test("a row of the span's Logs tab opens the log sheet on that log", () => {
		const ctx = contextAt(`spanId=${SPAN_ID}`)
		const open = answered(init(ctx, TRACE_ID).model, Option.some(trace), ctx).model
		const spanLog = {
			key: "k1",
			timestamp: "2026-10-01 11:59:00.004000000",
			severityText: "ERROR",
			severityNumber: 17,
			serviceName: "storefront",
			body: "card declined",
			traceId: TRACE_ID,
			spanId: SPAN_ID,
			recordIdentity: "1",
			logAttributes: {},
			resourceAttributes: {},
		}
		const logsKey = open.panel?.logs.key ?? ""
		const withLogs = update(
			open,
			Message.SucceededFetchSpanLogs({ key: logsKey, logs: [spanLog], fetchedAtMs: NOW }),
			ctx,
		).model
		const clicked = update(withLogs, Message.ClickedSpanLog({ log: spanLog }), ctx).model
		const sheet = Option.getOrNull(clicked.panelLogSheet)
		expect([sheet?.dialog.isOpen, sheet?.log.body]).toEqual([true, "card declined"])
	})

	test("a Refresh that finds the spans of a not-yet-landed trace mounts the tab and the hash's panel", () => {
		const ctx = contextAt(`spanId=${SPAN_ID}`)
		const empty = answered(init(ctx, TRACE_ID).model, Option.none(), ctx).model
		const refreshed = update(empty, Message.ClickedRefresh(), ctx).model
		const landed = answered(refreshed, Option.some(trace), ctx).model
		const rootCount = Option.map(landed.timeline, (timeline) => timeline.rootSpans.length)
		expect([Option.getOrNull(rootCount), landed.panel?.span.spanId]).toEqual([1, SPAN_ID])
	})

	test("a refetch that adds spans rebuilds the open tab on the new tree", () => {
		const loaded = answered(entered.model, Option.some(trace)).model
		const child = {
			...span,
			spanId: Schema.decodeSync(SpanId)("2222222222222222"),
			parentSpanId: SPAN_ID,
			spanName: "db",
		}
		const grown: TraceData = {
			...trace,
			spans: [span, child],
			rootSpans: [{ ...span, children: [{ ...child, children: [], depth: 1 }], depth: 0 }],
		}
		const refetched = answered(
			pageUpdate(loaded, Message.ClickedRefresh()).model,
			Option.some(grown),
		).model
		const children = Option.map(refetched.timeline, (timeline) =>
			timeline.rootSpans[0]?.children.map((node) => node.spanName),
		)
		expect(Option.getOrNull(children)).toEqual(["db"])
	})
})
