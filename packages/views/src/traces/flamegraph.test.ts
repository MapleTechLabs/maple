import { formatWarehouseDateTimeMs } from "@maple/query-engine"
import { buildTraceDetail, type SpanHierarchyRow } from "@maple/ui/lib/span-tree"
import { Option } from "effect"
import type { HtmlBuilder } from "foldkit/html"
import { click, given, expect as expectScene, Mount, role, scene, text } from "foldkit/scene"
import { Lazy } from "foldkit/test"
import { describe, expect, test } from "vitest"
import * as Tooltip from "../ui/tooltip"
import { barTriggerId, init, Message, type Model, MountFlamegraph, OutMessage, update } from "./flamegraph"
import { view } from "./flamegraph-view"
import { findSpanById } from "../service-map/trace-flow/flow-graph"
import { flamegraphBars, type FlamegraphInput } from "./flamegraph-layout"

const T0 = new Date("2026-07-21T10:00:00.000Z").getTime()
const row = (
	spanId: string,
	parentSpanId: string,
	startMs: number,
	durationMs: number,
): SpanHierarchyRow => ({
	traceId: "flame-trace",
	spanId,
	parentSpanId,
	spanName: spanId,
	serviceName: "checkout",
	spanKind: "Internal",
	durationMs,
	startTime: formatWarehouseDateTimeMs(T0 + startMs),
	statusCode: "Ok",
	statusMessage: "",
	spanAttributes: "{}",
	resourceAttributes: "{}",
})

// root 0-100; two overlapping children (a 0-40, b 30-70) and a grandchild c 10-30 under a.
const detail = buildTraceDetail([
	row("root", "", 0, 100),
	row("a", "root", 0, 40),
	row("b", "root", 30, 40),
	row("c", "a", 10, 20),
])
const input: FlamegraphInput = {
	rootSpans: detail.rootSpans,
	totalDurationMs: detail.totalDurationMs,
	traceStartTime: detail.traceStartTime,
	services: detail.services,
}
const step = update(input)
const lanes = (focused?: string) =>
	Object.fromEntries(
		flamegraphBars(
			input,
			focused === undefined ? undefined : findSpanById(input.rootSpans, focused),
		).bars.map((bar) => [
			bar.span.spanId,
			{ lane: bar.lane, left: bar.leftPercent, width: bar.widthPercent },
		]),
	)

describe("flamegraph layout", () => {
	test("overlapping spans of one depth take separate lanes, and deeper spans go below all of them", () => {
		expect(lanes()).toEqual({
			root: { lane: 0, left: 0, width: 100 },
			a: { lane: 1, left: 0, width: 40 },
			b: { lane: 2, left: 30, width: 40 },
			c: { lane: 3, left: 10, width: 20 },
		})
	})

	test("zooming into a span lays out its subtree over the span's own duration", () => {
		expect(lanes("a")).toEqual({
			a: { lane: 0, left: 0, width: 100 },
			c: { lane: 1, left: 25, width: 50 },
		})
	})
})

describe("flamegraph update", () => {
	test("a click selects (for the parent); Shift+click zooms, and again on the same bar zooms out", () => {
		const selected = step(init("f"), Message.ClickedBar({ spanId: "b", isShift: false }))
		expect(selected.outMessage).toEqual(OutMessage.SelectedSpan({ spanId: "b" }))
		expect(selected.model.focusedSpanId).toEqual(Option.none())
		const zoomed = step(init("f"), Message.ClickedBar({ spanId: "a", isShift: true }))
		expect(zoomed.model.focusedSpanId).toEqual(Option.some("a"))
		expect(zoomed.outMessage).toBeUndefined()
		expect(
			step(zoomed.model, Message.ClickedBar({ spanId: "a", isShift: true })).model.focusedSpanId,
		).toEqual(Option.none())
		expect(step(zoomed.model, Message.ClickedReset()).model.focusedSpanId).toEqual(Option.none())
	})

	test("the minimap zooms into the deepest span under the pointer", () => {
		const zoomed = step(init("f"), Message.ClickedBar({ spanId: "b", isShift: true })).model
		const focusOf = (percent: number) =>
			step(zoomed, Message.PointedMinimap({ percent })).model.focusedSpanId
		expect([focusOf(15), focusOf(35), focusOf(60), focusOf(90)]).toEqual([
			Option.some("c"),
			Option.some("a"),
			Option.some("b"),
			Option.some("root"),
		])
	})
})

describe("flamegraph view", () => {
	const sceneUpdate = (model: Model, message: Message) => {
		const next = step(model, message)
		return { model: next.model, commands: next.commands }
	}
	const sceneView = (model: Model, h: HtmlBuilder<Message>) =>
		view(h, model, { input, selectedSpanId: Option.none() }, (message) => message)
	const config = { update: sceneUpdate, view: sceneView }
	// The root's listener Mount, resolved as a Shift+click on `a` would report it.
	const shiftClickA = Mount.resolve(MountFlamegraph, Message.ClickedBar({ spanId: "a", isShift: true }))

	test("Shift+click zooms in: the header names the span, the minimap appears, Reset leaves it", () => {
		scene(
			config,
			given(init("f")),
			expectScene(text("Minimap")).toBeAbsent(),
			shiftClickA,
			expectScene(text("Minimap")).toExist(),
			expectScene(text("(40.0ms)")).toExist(),
			click(role("button", { name: "Reset" })),
			expectScene(text("Minimap")).toBeAbsent(),
			expectScene(role("button", { name: "Reset" })).toBeAbsent(),
		)
	})

	test("the open tooltip describes the hovered bar's span", () => {
		const base = init("f")
		const model = {
			...base,
			tooltip: { ...base.tooltip, isOpen: true, triggerId: barTriggerId(base.id, "b") },
		}
		scene(
			config,
			given(model),
			Mount.resolve(MountFlamegraph, Message.ClickedBar({ spanId: "b", isShift: false })),
			Mount.resolve(Tooltip.MountTooltip, Tooltip.Message.CompletedMountTooltip()),
			expectScene(text("Start offset")).toExist(),
			expectScene(text("+30.0ms")).toExist(),
		)
	})

	test("a render that changes nothing the bars read reuses them", () => {
		const zoomed = step(init("f"), Message.ClickedBar({ spanId: "a", isShift: true })).model
		Lazy.expectAllReused({ view: sceneView, model: zoomed })
	})
})
