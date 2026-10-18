import { SpanId, TraceId } from "@maple/domain"
import type { TraceData } from "@maple/web-foldkit/page/traces/detail/trace-data"
import { Option, Schema } from "effect"
import { expect as expectView, given, Mount, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { type PageContext, PageOutMessage } from "../contract"
import type { PageViewInputs } from "../kit/inputs"
import { FetchSpanDetail, FetchSpanLogs, FetchTrace, TrackPointer } from "./command"
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
	canGoBack: false,
})
const context = contextAt("")
const inputs: PageViewInputs = {
	context,
	presenceOf: () => Option.none(),
	presenceNowMs: NOW,
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
	update(model, Message.SucceededFetchTrace({ key: model.trace.key ?? "", trace: answer, fetchedAtMs: NOW }), ctx)

describe("local trace detail", () => {
	test("entry asks for the span hierarchy of the trace", () => {
		expect(entered.commands.map(({ name }) => name)).toEqual([FetchTrace.name])
	})

	test("an answer for a superseded key is dropped", () => {
		const stale = pageUpdate(entered.model, Message.SucceededFetchTrace({ key: "stale", trace: Option.some(trace), fetchedAtMs: NOW }))
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
		expect((selected.commands ?? []).map(({ name }) => name)).toEqual(expect.arrayContaining([FetchSpanLogs.name, FetchSpanDetail.name]))
	})

	test("Escape with a panel open drops the span from the hash", () => {
		const ctx = contextAt(`spanId=${SPAN_ID}`)
		const open = answered(init(ctx, TRACE_ID).model, Option.some(trace), ctx).model
		const closed = update(open, Message.PressedEscape(), ctx)
		expect(closed.outMessage).toEqual(PageOutMessage.RequestedNavigation({ hash: `#/traces/${TRACE_ID}`, isReplace: true }))
	})
})
