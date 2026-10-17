import {
	computeNodePositions,
	DEFAULT_LAYOUT_CONFIG,
} from "@maple/ui/components/service-map/service-map-utils"
import {
	BENCH_CLOUDFLARE_SERVICES,
	DEFAULT_BENCH_PARAMS,
	DURATION_SECONDS,
	generateBenchGraph,
} from "@maple/web/lab/bench/service-map-bench-fixture"
import { Option } from "effect"
import type { HtmlBuilder } from "foldkit/html"
import {
	click,
	expect,
	expectHandled,
	given,
	Mount,
	role,
	scene,
	selector,
	testId,
	within,
} from "foldkit/scene"
import { describe, test, expect as expectValue } from "vitest"
import { AttachFlowCanvas } from "../xyflow/attach"
import * as Canvas from "../xyflow/canvas"
import { buildSourceGraph } from "./graph"
import * as ServiceMap from "./service-map"
import { view } from "./view"

const bench = generateBenchGraph({ ...DEFAULT_BENCH_PARAMS, services: 8, edges: 12, rps: "med", seed: 3 })
const source = buildSourceGraph({
	edges: bench.edges,
	dbEdges: bench.dbEdges,
	serviceOverviews: bench.overviews,
	durationSeconds: DURATION_SECONDS,
	serviceWorkloads: bench.workloads,
	platforms: bench.platforms,
	runtimes: bench.runtimes,
	cloudflareServices: [...BENCH_CLOUDFLARE_SERVICES],
})
const initial = ServiceMap.init(source, { minTrafficPct: 0, focus: Option.none() })
const signature = initial.model.graph.signature
const elkPositions = Object.fromEntries(
	computeNodePositions([...initial.model.graph.nodes], [...initial.model.graph.edges], {
		...DEFAULT_LAYOUT_CONFIG,
	}),
)

const update = ServiceMap.update
const mapView = (model: ServiceMap.Model, h: HtmlBuilder<ServiceMap.Message>) =>
	view(h, model, (message) => message)

/** ELK answered and the pane has a size; the canvas Mount has not measured the cards yet. */
const revealed: ServiceMap.Model = (() => {
	const model = update(
		initial.model,
		ServiceMap.Message.SucceededElkLayout({ signature, positions: elkPositions }),
	).model
	return { ...model, canvas: { ...model.canvas, pane: { width: 1440, height: 800 } } }
})()

const measured = Mount.resolve(
	{ name: AttachFlowCanvas.name },
	ServiceMap.Message.GotCanvasMessage({
		message: Canvas.Message.MeasuredNodes({
			nodes: initial.model.graph.nodes.map((node) => ({
				id: node.id,
				width: 220,
				height: 61,
				handles: [
					{
						type: "target" as const,
						position: "left" as const,
						x: -1,
						y: 29.5,
						width: 2,
						height: 2,
					},
					{
						type: "source" as const,
						position: "right" as const,
						x: 219,
						y: 29.5,
						width: 2,
						height: 2,
					},
				],
			})),
		}),
	}),
)

const card = (id: string) => within(testId(`rf__node-${id}`), selector(".cursor-pointer"))

const select = (model: ServiceMap.Model, nodeId: string) =>
	update(model, ServiceMap.Message.ClickedNode({ nodeId }))

describe("service map selection", () => {
	test("cards and the empty pane answer clicks once measured", () => {
		scene(
			{ update, view: mapView },
			given(revealed),
			measured,
			click(card("svc-002")),
			expectHandled(),
			click(selector(".react-flow__pane")),
			expectHandled(),
		)
	})

	test("a click selects a node, clicking it again or the pane clears it, another click moves it", () => {
		const selected = select(revealed, "svc-002").model
		expectValue(selected.selectedId).toEqual(Option.some("svc-002"))
		expectValue(select(selected, "svc-002").model.selectedId).toEqual(Option.none())
		expectValue(select(selected, "svc-004").model.selectedId).toEqual(Option.some("svc-004"))
		expectValue(update(selected, ServiceMap.Message.ClickedPane()).model.selectedId).toEqual(
			Option.none(),
		)
	})

	test("with the traffic filter off, a selection neither re-keys the layout nor re-runs ELK", () => {
		const next = select(revealed, "svc-002")
		expectValue(next.model.graph.signature).toBe(revealed.graph.signature)
		expectValue(next.commands ?? []).toHaveLength(0)
	})
})

describe("service map layout", () => {
	test("the loading skeleton stays until a layout for the current graph lands", () => {
		scene(
			{ update, view: mapView },
			given(initial.model),
			expect(role("img", { name: "Loading service map" })).toExist(),
		)
		const stale = update(
			initial.model,
			ServiceMap.Message.SucceededElkLayout({ signature: "stale", positions: elkPositions }),
		)
		expectValue(stale.model.revealed).toBe(false)
	})

	test("the grace period reveals the synchronous layout, and ELK's answer replaces it", () => {
		const fallback = update(initial.model, ServiceMap.Message.ElapsedLayoutGrace({ signature })).model
		expectValue(fallback.layout.status).toBe("fallback")
		expectValue(fallback.revealed).toBe(true)
		const ready = update(
			fallback,
			ServiceMap.Message.SucceededElkLayout({ signature, positions: elkPositions }),
		).model
		expectValue(ready.layout.status).toBe("ready")
		const late = update(ready, ServiceMap.Message.ElapsedLayoutGrace({ signature })).model
		expectValue(late.layout).toBe(ready.layout)
	})
})
