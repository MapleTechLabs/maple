import { SpanId, TraceId } from "@maple/domain"
import type { TraceData } from "@maple/views/traces/trace-data"
import { Option, Schema, Array as Arr } from "effect"
import { expect as expectView, given, Mount, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { type PageContext, PageOutMessage } from "../contract"
import type { PageViewInputs } from "../kit/inputs"
import * as SpanPanel from "@maple/views/traces/span-panel"
import { FetchSpanDetail, FetchSpanLogs } from "@maple/views/traces/span-panel/command"
import { FetchTrace, ReadSpanLog, TrackPointer } from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import { init, locationChanged, update } from "./update"
import { view as pageView } from "./view"

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
const inputs: PageViewInputs = {
	context,
	presenceOf: () => ({ status: "unknown", lastSeenMs: null }),
	presenceNowMs: NOW,
	clockMs: 0,
	hasNewDataSince: () => false,
}
const view = withViewInputs(pageView, inputs)()
const pageUpdate = (model: Model, message: Message) => update(model, message, context)

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

const entered = init(context, TRACE_ID)
const answered = (model: Model, answer: Option.Option<TraceData>, ctx = context) =>
	update(
		model,
		Message.SucceededFetchTrace({ key: model.trace.key ?? "", trace: answer, fetchedAtMs: NOW }),
		ctx,
	)

describe("local trace detail", () => {
	test("entry asks for the span hierarchy of the trace", () => {
		expect(Arr.map(entered.commands, ({ name }) => name)).toEqual([FetchTrace.name])
	})

	test("an answer for a superseded key is dropped", () => {
		const stale = pageUpdate(
			entered.model,
			Message.SucceededFetchTrace({ key: "stale", trace: Option.some(trace), fetchedAtMs: NOW }),
		)
		expect(stale.model.trace).toEqual(entered.model.trace)
		expect(stale.model.timeline).toBeNull()
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
		expect(loaded.timeline).not.toBeNull()
		expect(loaded.panel).toBeNull()
		const selected = locationChanged(loaded, contextAt(`spanId=${SPAN_ID}`))
		expect(selected.model.panel?.span.spanId).toBe(SPAN_ID)
		expect(Arr.map(selected.commands ?? [], ({ name }) => name)).toEqual(
			expect.arrayContaining([FetchSpanLogs.name, FetchSpanDetail.name]),
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
		const clicked = update(
			open,
			Message.GotSpanPanelMessage({ message: SpanPanel.Message.ClickedLog({ key: "k1" }) }),
			ctx,
		)
		expect(Arr.map(clicked.commands ?? [], ({ name }) => name)).toEqual([ReadSpanLog.name])
		const found = update(clicked.model, Message.FoundSpanLog({ log: spanLog }), ctx).model
		const sheet = Option.getOrNull(found.maybeLogSheet)
		expect([sheet?.dialog.isOpen, sheet?.log?.body]).toEqual([true, "card declined"])
	})

	test("the log sheet closes when its trace link moves the hash to the log's span", () => {
		const ctx = contextAt(`spanId=${SPAN_ID}`)
		const open = answered(init(ctx, TRACE_ID).model, Option.some(trace), ctx).model
		const spanLog = {
			timestamp: "2026-10-01 11:59:00.004000000",
			severityText: "INFO",
			severityNumber: 9,
			serviceName: "storefront",
			body: "charged",
			traceId: TRACE_ID,
			spanId: "2222222222222222",
			recordIdentity: "2",
			logAttributes: {},
			resourceAttributes: {},
		}
		const found = update(open, Message.FoundSpanLog({ log: spanLog }), ctx).model
		const followed = locationChanged(found, contextAt("spanId=2222222222222222"))
		expect(Option.map(followed.model.maybeLogSheet, (sheet) => sheet.dialog.isOpen)).toEqual(
			Option.some(false),
		)
	})

	test("a clicked log that can no longer be read refreshes the span's reads", () => {
		const ctx = contextAt(`spanId=${SPAN_ID}`)
		const open = answered(init(ctx, TRACE_ID).model, Option.some(trace), ctx).model
		const failed = update(open, Message.FailedReadSpanLog(), ctx)
		expect(Arr.map(failed.commands ?? [], ({ name }) => name)).toEqual(
			expect.arrayContaining([FetchSpanLogs.name, FetchSpanDetail.name]),
		)
	})

	test("a Refresh that finds the spans of a not-yet-landed trace mounts the tab and the hash's panel", () => {
		const ctx = contextAt(`spanId=${SPAN_ID}`)
		const empty = answered(init(ctx, TRACE_ID).model, Option.none(), ctx).model
		const refreshed = update(empty, Message.ClickedRefresh(), ctx).model
		const landed = answered(refreshed, Option.some(trace), ctx).model
		expect([landed.timeline?.rootSpans.length, landed.panel?.span.spanId]).toEqual([1, SPAN_ID])
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
		const children = refetched.timeline?.rootSpans[0]?.children
		expect(children === undefined ? undefined : Arr.map(children, (node) => node.spanName)).toEqual([
			"db",
		])
	})
})
