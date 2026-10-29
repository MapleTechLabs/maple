import { SpanId, TraceId } from "@maple/domain"
import { Schema } from "effect"
import {
	click,
	expect as expectView,
	expectOutMessage,
	given,
	Mount,
	role,
	scene,
	selector,
	text,
	type as typeInto,
	withViewInputs,
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import type { SpanNodeData, TraceData } from "../trace-data"
import { MeasureTimelineBody, MountAltToggle, ScrollToRow } from "./command"
import { Message, OutMessage } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { view as timelineView } from "./view"

const traceId = Schema.decodeSync(TraceId)("6843a8853182b32339b2dd5120d423f2")
const spanId = Schema.decodeSync(SpanId)

const node = (
	id: string,
	name: string,
	depth: number,
	offsetMs: number,
	children: ReadonlyArray<SpanNodeData> = [],
	service = "storefront",
): SpanNodeData => ({
	traceId,
	spanId: spanId(id),
	parentSpanId: "",
	spanName: name,
	serviceName: service,
	spanKind: "Server",
	durationMs: 100 - offsetMs,
	startTime: new Date(Date.UTC(2026, 9, 1, 11, 43, 32) + offsetMs).toISOString(),
	statusCode: "Ok",
	statusMessage: "",
	spanAttributes: {},
	resourceAttributes: {},
	children,
	depth,
})

const leaf = node("00000000000000c1", "SELECT payments", 2, 20, [], "payment-svc")
const child = node("00000000000000b1", "GET /charges", 1, 10, [leaf], "payment-svc")
const sibling = node("00000000000000b2", "GET /session", 1, 5)
const root = node("00000000000000a1", "GET /order", 0, 0, [sibling, child])

const trace: TraceData = {
	traceId,
	spans: [root, sibling, child, leaf],
	rootSpans: [root],
	totalDurationMs: 100,
	traceStartTime: root.startTime,
}

const entered = (selectedSpanId: string | null = null): Model =>
	init({
		trace,
		traceStartTime: trace.traceStartTime ?? "",
		selectedSpanId,
		colorBy: "preset:service",
		spanEvents: null,
	}).model

const view = withViewInputs(timelineView, { idPrefix: "t" })()
const measured = () =>
	Mount.resolve(MeasureTimelineBody, Message.MeasuredScroller({ width: 900, height: 400 }))
const altToggle = () =>
	Mount.resolve(MountAltToggle, Message.AltClickedToggleCollapse({ spanId: "no-such-span" }))

describe("trace timeline", () => {
	test("a small trace opens fully expanded, one row per span in the measured window", () => {
		scene(
			{ update, view },
			given(entered()),
			measured(),
			altToggle(),
			expectView(selector('[data-row-id="00000000000000c1"]')).toExist(),
			expectView(text("SELECT payments")).toExist(),
		)
		expect(entered().expandedSpanIds).toEqual(
			expect.arrayContaining(["00000000000000a1", "00000000000000b1"]),
		)
	})

	test("collapse all leaves the root, expand all restores every row", () => {
		scene(
			{ update, view },
			given(entered()),
			measured(),
			altToggle(),
			click(role("button", { name: "Collapse all" })),
			expectView(selector('[data-row-id="00000000000000b2"]')).not.toExist(),
			expectView(selector('[data-row-id="00000000000000a1"]')).toExist(),
			click(role("button", { name: "Expand all" })),
			expectView(selector('[data-row-id="00000000000000c1"]')).toExist(),
		)
	})

	test("one level at a time: collapse folds the deepest open level, expand reopens the shallowest", () => {
		const collapsed = update(entered(), Message.ClickedCollapseOneLevel()).model
		expect(collapsed.expandedSpanIds).toEqual(["00000000000000a1"])
		const again = update(collapsed, Message.ClickedCollapseOneLevel()).model
		expect(again.expandedSpanIds).toEqual([])
		const reopened = update(again, Message.ClickedExpandOneLevel()).model
		expect(reopened.expandedSpanIds).toEqual(["00000000000000a1"])
	})

	test("⌥ on a toggle closes and reopens the whole subtree; a plain toggle only the span", () => {
		const closed = update(
			entered(),
			Message.AltClickedToggleCollapse({ spanId: "00000000000000a1" }),
		).model
		expect(closed.expandedSpanIds).toEqual([])
		const reopened = update(
			closed,
			Message.AltClickedToggleCollapse({ spanId: "00000000000000a1" }),
		).model
		expect(reopened.expandedSpanIds).toEqual(entered().expandedSpanIds)
		const plain = update(closed, Message.ClickedToggleCollapse({ spanId: "00000000000000a1" })).model
		expect(plain.expandedSpanIds).toEqual(["00000000000000a1"])
	})

	test("clicking a row asks the page to select its span", () => {
		scene(
			{ update, view },
			given(entered()),
			measured(),
			altToggle(),
			click(selector('[data-row-id="00000000000000b2"]')),
			expectOutMessage(OutMessage.SelectedSpan({ spanId: "00000000000000b2" })),
		)
	})

	test("searching dims the misses, counts the matches and Enter steps through them", () => {
		scene(
			{ update, view },
			given(entered()),
			measured(),
			altToggle(),
			typeInto(role("textbox"), "GET"),
			expectView(text("3 of 4")).toExist(),
			expectView(role("button", { name: "Clear search" })).toExist(),
		)
		const searched = update(entered(), Message.ChangedSearch({ query: "GET" })).model
		const stepped = update(searched, Message.PressedSearchKey({ key: "Enter", isShift: false })).model
		expect(stepped.matchCursor).toBe(1)
		expect(stepped.focusedIndex).toBe(0)
	})

	test("picking a color scheme is reported to the page; the same one is ignored", () => {
		const model = entered()
		expect(update(model, Message.SelectedColorBy({ colorBy: "preset:spanKind" })).outMessage).toEqual(
			OutMessage.ChangedColorBy({ colorBy: "preset:spanKind" }),
		)
		expect(
			update(model, Message.SelectedColorBy({ colorBy: "preset:service" })).outMessage,
		).toBeUndefined()
	})

	test("a page-driven selection scrolls the new span into view, an unchanged one does nothing", () => {
		const inform = Message.InformedOfSelectedSpanId({ spanId: "00000000000000c1" })
		const selected = update(entered(), inform)
		expect(selected.model.selectedSpanId).toBe("00000000000000c1")
		expect((selected.commands ?? []).map((command) => command.name)).toEqual([ScrollToRow.name])
		expect(update(selected.model, inform).commands).toBeUndefined()
	})
})
