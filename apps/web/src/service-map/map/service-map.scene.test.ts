import {
	computeNodePositions,
	DEFAULT_LAYOUT_CONFIG,
} from "@maple/ui/components/service-map/service-map-utils"
import {
	BENCH_CLOUDFLARE_SERVICES,
	DEFAULT_BENCH_PARAMS,
	DURATION_SECONDS,
	generateBenchGraph,
} from "../../lab/bench/service-map-bench-fixture"
import { Option } from "effect"
import {
	click,
	Command,
	expect,
	expectHandled,
	given,
	Mount,
	role,
	scene,
	selector,
	testId,
	withViewInputs,
	within,
} from "foldkit/scene"
import { Lazy, toParentMessage } from "foldkit/test"
import { describe, test, expect as expectValue } from "vitest"
import { Message as ComboboxMessage } from "../../ui/combobox"
import { Message as ResizableMessage, MountResizeGroup } from "../../ui/resizable"
import { Message as SelectMessage } from "../../ui/select"
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
const mapView = withViewInputs(view, {})()

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
	ServiceMap.Message.ReceivedCanvasMessage({
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

const canvas = (message: Canvas.Message) => ServiceMap.Message.ReceivedCanvasMessage({ message })

describe("service map selection", () => {
	test("cards and the empty pane answer clicks once measured", () => {
		scene(
			{ update, view: mapView },
			given(revealed),
			measured,
			Mount.resolve(MountResizeGroup, ResizableMessage.EndedDrag()),
			Command.resolve(
				ServiceMap.WaitCameraWrite,
				ServiceMap.Message.ElapsedCameraWrite({ version: 1 }),
			),
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

	test("a new signature keeps its bridge on screen for a painted frame before ELK's answer lands", () => {
		const start = ServiceMap.init(groupedSource, { minTrafficPct: 0, focus: Option.none() }).model
		const shown = update(
			start,
			ServiceMap.Message.SucceededElkLayout({
				signature: start.graph.signature,
				positions: Object.fromEntries(
					computeNodePositions([...start.graph.nodes], [...start.graph.edges], {
						...DEFAULT_LAYOUT_CONFIG,
					}),
				),
			}),
		).model
		const collapsed = update(
			shown,
			ServiceMap.Message.ClickedCollapseNamespace({ namespace: "payments" }),
		).model
		expectValue(Option.map(collapsed.bridge, (bridge) => bridge.signature)).toEqual(
			Option.some(collapsed.graph.signature),
		)
		const elk = { signature: collapsed.graph.signature, positions: { "nsagg:payments": { x: 1, y: 2 } } }
		const held = update(collapsed, ServiceMap.Message.SucceededElkLayout(elk)).model
		expectValue(held.layout.status).toBe("pending")
		const painted = update(held, ServiceMap.Message.PaintedBridge({ signature: elk.signature })).model
		expectValue(painted.layout.status).toBe("ready")
		expectValue(painted.positions["nsagg:payments"]).toEqual({ x: 1, y: 2 })
	})
})

describe("service map drags and camera", () => {
	test("a finished drag moves the node and is saved under the live signature", () => {
		const dragging = update(
			revealed,
			canvas(Canvas.Message.DraggedNode({ id: "svc-002", position: { x: 5, y: 6 } })),
		).model
		expectValue(dragging.positions["svc-002"]).toEqual({ x: 5, y: 6 })
		expectValue(dragging.snapshots).toHaveLength(0)
		const dropped = update(
			dragging,
			canvas(Canvas.Message.EndedNodeDrag({ id: "svc-002", position: { x: 7, y: 8 } })),
		).model
		expectValue(dropped.positions["svc-002"]).toEqual({ x: 7, y: 8 })
		expectValue(dropped.snapshots[0]?.signature).toBe(signature)
		expectValue(dropped.snapshots[0]?.positions["svc-002"]).toEqual({ x: 7, y: 8 })
	})

	test("a finished drag tells the host to persist the layout; a drag in progress does not", () => {
		const dragging = update(
			revealed,
			canvas(Canvas.Message.DraggedNode({ id: "svc-002", position: { x: 5, y: 6 } })),
		)
		expectValue(dragging.outMessage).toBeUndefined()
		const dropped = update(
			dragging.model,
			canvas(Canvas.Message.EndedNodeDrag({ id: "svc-002", position: { x: 7, y: 8 } })),
		)
		expectValue(dropped.outMessage?.isLayoutChanged).toBe(true)
		expectValue(dropped.outMessage?.isPrefsChanged).toBe(false)
		expectValue(dropped.outMessage?.snapshots).toEqual(dropped.model.snapshots)
	})

	test("selecting a node opens the detail split and reports the selection", () => {
		const selected = select(revealed, "svc-002")
		expectValue(selected.model.split.layout).toEqual([64.999, 35.001])
		expectValue(selected.outMessage?.previousSelectedId).toEqual(Option.none())
		expectValue(selected.outMessage?.selectedId).toEqual(Option.some("svc-002"))
		expectValue(update(selected.model, ServiceMap.Message.ClickedPane()).model.split.layout).toEqual([
			100,
		])
	})

	test("Re-sort drops the saved arrangement and snaps back to the layout", () => {
		const dropped = update(
			revealed,
			canvas(Canvas.Message.EndedNodeDrag({ id: "svc-002", position: { x: 7, y: 8 } })),
		).model
		const resorted = update(dropped, ServiceMap.Message.ClickedResort()).model
		expectValue(resorted.snapshots).toHaveLength(0)
		expectValue(resorted.positions["svc-002"]).toEqual(elkPositions["svc-002"])
	})

	test("the last camera of a burst is written, earlier timers are dropped", () => {
		const first = update(revealed, canvas(Canvas.Message.EndedViewportMove()))
		const second = update(first.model, canvas(Canvas.Message.EndedViewportMove()))
		expectValue(second.model.cameraWrite).toBe(2)
		const stale = update(second.model, ServiceMap.Message.ElapsedCameraWrite({ version: 1 })).model
		expectValue(stale.snapshots).toHaveLength(0)
		const written = update(second.model, ServiceMap.Message.ElapsedCameraWrite({ version: 2 })).model
		expectValue(written.snapshots[0]?.viewport).toEqual(revealed.canvas.viewport)
	})

	test("a signature with a saved camera restores it instead of fitting", () => {
		const saved = { x: 11, y: 12, zoom: 0.5 }
		const next = ServiceMap.init(source, {
			minTrafficPct: 0,
			focus: Option.none(),
			snapshots: [{ signature, positions: {}, viewport: saved }],
		}).model
		expectValue(next.canvas.viewport).toEqual(saved)
		const shown = update(
			next,
			ServiceMap.Message.SucceededElkLayout({ signature, positions: elkPositions }),
		)
		expectValue(shown.model.canvas.pendingFit).toEqual(Option.none())
	})
})

const grouped = generateBenchGraph({
	...DEFAULT_BENCH_PARAMS,
	services: 8,
	edges: 12,
	rps: "med",
	seed: 3,
	groups: 2,
})
const groupedSource = buildSourceGraph({
	edges: grouped.edges,
	dbEdges: grouped.dbEdges,
	serviceOverviews: grouped.overviews,
	durationSeconds: DURATION_SECONDS,
	serviceWorkloads: grouped.workloads,
	platforms: grouped.platforms,
	runtimes: grouped.runtimes,
	cloudflareServices: [...BENCH_CLOUDFLARE_SERVICES],
})

describe("service map declutter controls", () => {
	test("collapsing a namespace re-keys the layout; clicking its aggregate expands it again", () => {
		const start = ServiceMap.init(groupedSource, { minTrafficPct: 0, focus: Option.none() }).model
		const collapsed = update(
			start,
			ServiceMap.Message.ClickedCollapseNamespace({ namespace: "payments" }),
		)
		expectValue(collapsed.model.collapsedNamespaces).toEqual(["payments"])
		expectValue(collapsed.model.graph.signature).not.toBe(start.graph.signature)
		const isElk = Command.argsOf(ServiceMap.RunElkLayout)
		expectValue((collapsed.commands ?? []).some((command) => Option.isSome(isElk(command)))).toBe(true)
		const expanded = update(collapsed.model, ServiceMap.Message.ClickedNode({ nodeId: "nsagg:payments" }))
		expectValue(expanded.model.collapsedNamespaces).toEqual([])
		expectValue(expanded.model.graph.signature).toBe(start.graph.signature)
	})

	test("picking a service in the combobox focuses it; clearing restores a fresh combobox", () => {
		const focused = update(
			revealed,
			toParentMessage(
				ServiceMap.FocusComboboxBinding,
				ComboboxMessage.ClickedItem({ value: "svc-002" }),
			),
		).model
		expectValue(focused.focus).toEqual(Option.some({ serviceId: "svc-002", hops: 1, mode: "dim" }))
		expectValue(focused.graph.declutter.dimmedNodeIds.size).toBeGreaterThan(0)
		const deeper = update(
			focused,
			toParentMessage(
				ServiceMap.DepthSelectBinding,
				SelectMessage.SelectedItem({ index: 1, value: "2" }),
			),
		).model
		expectValue(Option.map(deeper.focus, (focus) => focus.hops)).toEqual(Option.some(2))
		const hidden = update(deeper, ServiceMap.Message.ClickedToggleHideRest()).model
		expectValue(Option.map(hidden.focus, (focus) => focus.mode)).toEqual(Option.some("hide"))
		const cleared = update(hidden, ServiceMap.Message.ClickedClearFocus()).model
		expectValue(cleared.focus).toEqual(Option.none())
		expectValue(cleared.toolbar.focusCombobox.inputValue).toBe("")
	})

	test("the colour and traffic selects drive the colour mode and the threshold", () => {
		const health = update(
			revealed,
			toParentMessage(
				ServiceMap.ColorSelectBinding,
				SelectMessage.SelectedItem({ index: 1, value: "health" }),
			),
		).model
		expectValue(health.colorMode).toBe("health")
		const filtered = update(
			revealed,
			toParentMessage(
				ServiceMap.TrafficSelectBinding,
				SelectMessage.SelectedItem({ index: 3, value: "5" }),
			),
		).model
		expectValue(filtered.minTrafficPct).toBe(5)
		expectValue(update(filtered, ServiceMap.Message.ClickedShowAllTraffic()).model.minTrafficPct).toBe(0)
	})

	test("the URL focus applies once; the same focus again changes nothing", () => {
		const focus = Option.some({ serviceId: "svc-002", hops: 1 as const, mode: "dim" as const })
		const setFocus = (model: ServiceMap.Model, next: typeof focus) =>
			update(model, ServiceMap.Message.InformedOfFocus({ focus: next }))
		const once = setFocus(revealed, focus).model
		expectValue(setFocus(once, focus).model).toBe(once)
		expectValue(setFocus(once, Option.none()).model.focus).toEqual(Option.none())
	})
})

describe("service map lazy layers", () => {
	test("an unchanged map reuses its node, edge, particle and minimap layers", () => {
		Lazy.expectAllReused({ view: mapView, model: revealed })
	})
})
