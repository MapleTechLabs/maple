import { SpanId, TraceId } from "@maple/domain"
import { Result, Schema } from "effect"
import { click, expect as expectView, given, Mount, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "../../../../data/load-failure"
import * as Tabs from "../../../../ui/tabs"
import type { SpanNodeData } from "../trace-data"
import { FetchSpanDetail, FetchSpanLogs } from "./command"
import { Message, OutMessage } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
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

const input = {
	span,
	traceId: span.traceId,
	traceStartTime: "2026-10-01 11:43:32.411",
	totalDurationMs: 4920,
	orgId: "org_acme",
}

const view = withViewInputs(panelView, { timeZone: "UTC" })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const detail = { spanAttributes: { "db.system.name": "postgresql" }, resourceAttributes: {}, events: [] }

const loaded = (): Model => {
	const entered = init(input).model
	return [
		Message.CompletedFetchDetail({ key: entered.detail.key ?? "", result: Result.succeed(detail) }),
		Message.CompletedFetchLogs({ key: entered.logs.key ?? "", result: Result.succeed([]) }),
	].reduce((model, message) => update(model, message).model, entered)
}

const indicatorMeasured = () =>
	Mount.resolve<string, Message>(
		Tabs.MeasureTabIndicator,
		Message.GotTabsMessage({
			message: Tabs.Message.MeasuredIndicator({
				rect: { left: 16, right: 300, top: 4, bottom: 5, width: 96, height: 32 },
			}),
		}),
	)

describe("span panel", () => {
	test("mounting asks for the span's logs and its full attributes", () => {
		expect(names(init(input).commands)).toEqual([FetchSpanLogs.name, FetchSpanDetail.name])
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
			Message.CompletedFetchDetail({ key: "org_acme\u0000other", result: Result.succeed(detail) }),
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
})
