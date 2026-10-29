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
	text,
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import type { SpanNodeData, TraceData } from "../trace-data"
import { Message, type Model, OutMessage } from "./model"
import { init, update } from "./update"
import { view } from "./view"
import { VirtualizeWaterfall } from "./virtualize"

const traceId = Schema.decodeSync(TraceId)("6843a8853182b32339b2dd5120d423f2")

const node = (
	id: string,
	depth: number,
	children: ReadonlyArray<SpanNodeData> = [],
	status = "Ok",
): SpanNodeData => ({
	traceId,
	spanId: Schema.decodeSync(SpanId)(id.padEnd(16, "0")),
	parentSpanId: "",
	spanName: `span ${id}`,
	serviceName: "storefront",
	spanKind: "Server",
	durationMs: 10,
	startTime: "2026-10-01T11:43:32.411Z",
	statusCode: status,
	statusMessage: "",
	spanAttributes: {},
	resourceAttributes: {},
	children: children.map((child) => ({ ...child, parentSpanId: id.padEnd(16, "0") })),
	depth,
})

const idOf = (id: string) => id.padEnd(16, "0")

/** root → a → b → c: three parents, four rows. */
const small: TraceData = {
	traceId,
	spans: [],
	rootSpans: [node("r", 0, [node("a", 1, [node("b", 2, [node("c", 3)])])])],
	totalDurationMs: 10,
	traceStartTime: "2026-10-01T11:43:32.411Z",
}

const entered = (trace: TraceData = small, selectedSpanId: string | null = null): Model =>
	init({ trace, traceStartTime: "2026-10-01T11:43:32.411Z", selectedSpanId }).model

const windowOver = (count: number) =>
	Message.ChangedVirtualWindow({
		rows: Array.from({ length: count }, (_, index) => ({ index, start: index * 33 })),
		totalSize: count * 33,
	})

describe("waterfall", () => {
	test("a short trace opens every parent; a long one folds deep levels but keeps errors open", () => {
		expect(new Set(entered().expanded)).toEqual(new Set([idOf("r"), idOf("a"), idOf("b")]))
		const deep = node("d0", 3, [node("d1", 4, [node("d2", 5)])])
		const failing = node("e0", 3, [node("e1", 4, [], "Error")])
		const filler = Array.from({ length: 24 }, (_, i) => node(`f${i}`, 1))
		const long: TraceData = {
			...small,
			rootSpans: [node("r", 0, [node("a", 1, [node("b", 2, [deep, failing])]), ...filler])],
		}
		const expanded = new Set(entered(long).expanded)
		expect(expanded.has(idOf("b"))).toBe(true)
		expect(expanded.has(idOf("d0"))).toBe(false)
		expect(expanded.has(idOf("e0"))).toBe(true)
	})

	test("collapsing hides rows and the header counts what is hidden", () => {
		scene(
			{ update, view },
			given(update(entered(), windowOver(4)).model),
			Mount.resolve(VirtualizeWaterfall, windowOver(4)),
			expectView(text("span c")).toExist(),
			click(role("button", { name: "Collapse all" })),
			expectView(text("span c")).not.toExist(),
			expectView(text("span a")).not.toExist(),
			expectView(text("span r")).toExist(),
		)
		const collapsed = update(entered(), Message.ClickedToggle({ spanId: idOf("a") })).model
		expect(collapsed.expanded).not.toContain(idOf("a"))
	})

	test("depth controls step one level and go all the way", () => {
		const oneUp = update(entered(), Message.ClickedCollapseOneLevel()).model
		expect(new Set(oneUp.expanded)).toEqual(new Set([idOf("r"), idOf("a")]))
		const oneDown = update(oneUp, Message.ClickedExpandOneLevel()).model
		expect(new Set(oneDown.expanded)).toEqual(new Set([idOf("r"), idOf("a"), idOf("b")]))
		const none = update(oneDown, Message.ClickedCollapseAll()).model
		expect(none.expanded).toEqual([])
		expect(new Set(update(none, Message.ClickedExpandAll()).model.expanded)).toEqual(
			new Set([idOf("r"), idOf("a"), idOf("b")]),
		)
	})

	test("clicking a row asks the page to select it", () => {
		expect(update(entered(), Message.ClickedRow({ spanId: idOf("b") })).outMessage).toEqual(
			OutMessage.SelectedSpan({ spanId: idOf("b") }),
		)
		scene(
			{ update, view },
			given(update(entered(), windowOver(4)).model),
			Mount.resolve(VirtualizeWaterfall, windowOver(4)),
			click(role("button", { name: /span b/ })),
			expectOutMessage(OutMessage.SelectedSpan({ spanId: idOf("b") })),
		)
	})

	test("a selection made after mount reveals its ancestors without undoing user toggles", () => {
		const folded = update(entered(), Message.ClickedCollapseAll()).model
		const selected = update(folded, Message.InformedOfSelectedSpan({ spanId: idOf("c") })).model
		expect(new Set(selected.expanded)).toEqual(new Set([idOf("r"), idOf("a"), idOf("b")]))
		expect(selected.selectedSpanId).toBe(idOf("c"))
	})
})
