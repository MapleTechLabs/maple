import { FLOW_LAB_TRACE } from "../../lab/flow-fixture"
import { Option } from "effect"
import type { HtmlBuilder } from "foldkit/html"
import { click, expect, given, hover, Mount, role, scene, selector, testId, within } from "foldkit/scene"
import { describe, test, expect as expectValue } from "vitest"
import { AttachFlowCanvas } from "../xyflow/attach"
import * as Canvas from "../xyflow/canvas"
import * as TraceFlow from "./trace-flow"
import { view } from "./view"
import * as FlowLab from "../../lab/flow-lab"

const graph = TraceFlow.buildFlowGraph({
	rootSpans: FLOW_LAB_TRACE.rootSpans,
	totalDurationMs: FLOW_LAB_TRACE.totalDurationMs,
	services: FLOW_LAB_TRACE.services,
})
const update = (model: TraceFlow.Model, message: TraceFlow.Message) => ({
	model: TraceFlow.update(graph)(model, message),
})
const flowView = (model: TraceFlow.Model, h: HtmlBuilder<TraceFlow.Message>) =>
	view(h, graph, model, (message) => message)

/** What the Mount reports for a 280x56 card with React Flow's 2x2 handles at the top and bottom centre. */
const measuredCards = Canvas.Message.MeasuredNodes({
	nodes: graph.nodes.map((node) => ({
		id: node.id,
		width: 280,
		height: 56,
		handles: [
			{ type: "target" as const, position: "top" as const, x: 139, y: -1, width: 2, height: 2 },
			{ type: "source" as const, position: "bottom" as const, x: 139, y: 55, width: 2, height: 2 },
		],
	})),
})

// Matched by name: the canvas Mount is mapped into the parent, so it resolves with the lifted Message.
const measured = Mount.resolve(
	{ name: AttachFlowCanvas.name },
	TraceFlow.Message.GotCanvasMessage({ message: measuredCards }),
)

/** A laid-out pane, as the Mount reports it before the cards are measured. */
const start: TraceFlow.Model = {
	...TraceFlow.init(),
	canvas: { ...TraceFlow.init().canvas, pane: { width: 1152, height: 600 } },
}

const authEdge = role("group", { name: "Edge from root to auth" })
/** The lab header's "Selected: <span name>". */
const selectedSpan = selector("p .font-mono")
const labView = (model: TraceFlow.Model, h: HtmlBuilder<TraceFlow.Message>) =>
	FlowLab.pageBody(h, model, (message) => message)

describe("trace flow view", () => {
	test("cards stay hidden until the canvas Mount measures them, then their edges draw", () => {
		scene(
			{ update, view: flowView },
			given(start),
			expect(testId("rf__node-root")).toHaveStyle("visibility", "hidden"),
			expect(authEdge).toBeAbsent(),
			measured,
			expect(testId("rf__node-root")).toHaveStyle("visibility", "visible"),
			expect(authEdge).toExist(),
		)
	})

	test("clicking a card selects its span; clicking another moves the selection", () => {
		scene(
			{ update, view: labView },
			given(start),
			measured,
			expect(selectedSpan).toHaveText("none"),
			click(within(testId("rf__node-pricing"), selector(".font-mono"))),
			expect(selectedSpan).toHaveText("PricingEngine.calculateTotals"),
			click(within(testId("rf__node-auth"), selector(".font-mono"))),
			expect(selectedSpan).toHaveText("SessionAuthn.verify"),
		)
	})

	test("hovering an edge reveals its offset, duration and share", () => {
		scene(
			{ update, view: flowView },
			given(start),
			measured,
			expect(authEdge).not.toContainText("8.0ms"),
			hover(within(authEdge, selector('path[stroke="transparent"]'))),
			expect(authEdge).toContainText("+6.0ms → 8.0ms (2%)"),
		)
	})
})

describe("trace flow update", () => {
	test("leaving an edge clears only that edge's hover", () => {
		const hovered = TraceFlow.update(graph)(
			TraceFlow.init(),
			TraceFlow.Message.HoveredEdge({ edgeId: "root-auth" }),
		)
		const leftOther = TraceFlow.update(graph)(
			hovered,
			TraceFlow.Message.LeftEdge({ edgeId: "root-edge" }),
		)
		const left = TraceFlow.update(graph)(hovered, TraceFlow.Message.LeftEdge({ edgeId: "root-auth" }))
		expectValue(leftOther.hoveredEdgeId).toEqual(Option.some("root-auth"))
		expectValue(left.hoveredEdgeId).toEqual(Option.none())
	})
})
