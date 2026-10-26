import {
	computeNodePositions,
	DB_NODE_PREFIX,
	DEFAULT_LAYOUT_CONFIG,
	isNsAggregateId,
	NS_AGGREGATE_PREFIX,
} from "@maple/ui/components/service-map/service-map-utils"
import { Duration, Effect, Option, Schema, type Stream } from "effect"
import { Command, Dom, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { modifyFields } from "foldkit/struct"
import * as Combobox from "../../ui/combobox"
import * as Popover from "../../ui/popover"
import * as Resizable from "../../ui/resizable"
import * as Select from "../../ui/select"
import * as Tooltip from "../../ui/tooltip"
import * as Canvas from "../xyflow/canvas"
import { Point } from "../xyflow/geometry"
import {
	declutterGraph,
	type EffectiveGraph,
	EffectiveGraphSchema,
	type SourceGraph,
	SourceGraphSchema,
} from "./graph"
import {
	ColorMode,
	DEFAULT_VIEW_PREFS,
	Focus,
	LayoutStatus,
	Positions,
	sameFocus,
	Snapshot,
	snapshotFor,
	upsert,
} from "./state"
import { namespaceBoxRects } from "./namespace-group"
import * as Toolbar from "./toolbar"

/**
 * `ServiceMapFlowCanvas` (packages/ui `service-map/service-map-canvas.tsx`) as a Submodel:
 * declutter (traffic, focus, collapsed namespaces), ELK layout in a worker with the synchronous
 * layout as a 2 s fallback, drags and camera per layout signature, selection with the detail
 * split, toolbar and legend. The host reads `focus`, the prefs and `snapshots` back to persist them.
 */

export { ColorMode, Focus, Positions, Snapshot } from "./state"

export const Model = Schema.Struct({
	source: SourceGraphSchema,
	graph: EffectiveGraphSchema,
	focus: Schema.Option(Focus),
	minTrafficPct: Schema.Number,
	collapsedNamespaces: Schema.Array(Schema.String),
	/** ELK's answer, or the synchronous stand-in it is replaced by after the grace period. */
	layout: Schema.Struct({ status: LayoutStatus, positions: Positions }),
	/** The signature's synchronous layout, anchored on what was on screen when it became live. */
	fallback: Schema.Struct({ signature: Schema.String, positions: Positions }),
	/** The first final or fallback layout has been shown; later recomputes keep the map visible. */
	revealed: Schema.Boolean,
	selectedId: Schema.Option(Schema.String),
	colorMode: ColorMode,
	/** `prefers-reduced-motion`; the particle canvas is not rendered while it applies. */
	reducedMotion: Schema.Boolean,
	canvas: Canvas.Model,
	/** `ServiceMapLayout`: drags and camera per layout signature, most recent first. */
	snapshots: Schema.Array(Snapshot),
	/** The first automatic fit snaps; every later one animates (`hasFittedOnce`). */
	hasFitted: Schema.Boolean,
	/** The host frames its first reveal even with namespace boxes (apps/local-ui does). */
	isFirstBoxedFitKept: Schema.Boolean,
	/** The live signature had a saved camera when it became live: no auto-fit. */
	hasSavedCamera: Schema.Boolean,
	/** Where nodes are drawn: the layout, the signature's saved drags, then a drag in progress. */
	positions: Positions,
	drag: Schema.Option(Schema.Struct({ id: Schema.String, position: Point })),
	/**
	 * A new signature's bridged layout (known nodes kept, new ones placed by the fallback) until it
	 * has been measured and painted: it is drawn for a frame before the layout worker answers.
	 */
	bridge: Schema.Option(Schema.Struct({ signature: Schema.String, isAwaitingPaint: Schema.Boolean })),
	/** ELK's answer, held while the bridge is not yet on screen. */
	heldLayout: Schema.Option(
		Schema.Struct({ signature: Schema.String, status: LayoutStatus, positions: Positions }),
	),
	/** Debounces camera writes (`VIEWPORT_PERSIST_DEBOUNCE_MS`). */
	cameraWrite: Schema.Number,
	toolbar: Toolbar.Model,
	legend: Popover.Model,
	split: Resizable.Model,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	GotCanvasMessage: { message: Canvas.Message },
	SucceededElkLayout: { signature: Schema.String, positions: Positions },
	FailedElkLayout: { signature: Schema.String },
	ElapsedLayoutGrace: { signature: Schema.String },
	ClickedNode: { nodeId: Schema.String },
	/** The 3D scene's `onSelect`: a machine, label or belt picked, or `null` for empty paper. */
	PickedNode: { nodeId: Schema.NullOr(Schema.String) },
	ClickedPane: {},
	ClickedResort: {},
	ChangedReducedMotion: { reduced: Schema.Boolean },
	CompletedMountParticles: {},
	ClickedCollapseNamespace: { namespace: Schema.String },
	ClickedClearFocus: {},
	ClickedToggleHideRest: {},
	ClickedShowAllTraffic: {},
	ClickedResetFilters: {},
	ClickedCloseDetail: {},
	ClickedFocusSelected: {},
	ElapsedCameraWrite: { version: Schema.Number },
	PaintedBridge: { signature: Schema.String },
	GotFocusComboboxMessage: { message: Combobox.Message },
	GotTrafficSelectMessage: { message: Select.Message },
	GotColorSelectMessage: { message: Select.Message },
	GotDepthSelectMessage: { message: Select.Message },
	GotTooltipMessage: { message: Tooltip.Message },
	GotLegendMessage: { message: Popover.Message },
	GotSplitMessage: { message: Resizable.Message },
})
export type Message = typeof Message.Type

type Return = Update.Return<Model, Message>

/**
 * `useMediaQuery("(prefers-reduced-motion: reduce)")`, which gates the particle canvas. The model
 * starts reduced, so every host must subscribe to this or the edges never animate.
 */
export const reducedMotionChanges: Stream.Stream<Message> = Dom.streamFromMediaQuery({
	query: "(prefers-reduced-motion: reduce)",
	mapMatches: (reduced) => Message.ChangedReducedMotion({ reduced }),
})

/** Default `fitView()` of the map: padding 0.1, never smaller than legible cards (then it pans). */
export const MAP_FIT: Canvas.FitRequest = {
	padding: 0.1,
	minZoom: 0.05,
	maxZoom: 2,
	readableZoom: Canvas.READABLE_FIT_ZOOM,
}

/** ELK in its worker (`layoutServiceMapWithElk`); the module and elkjs load on first use. */
export const RunElkLayout = Command.define("RunElkLayout", {
	args: { signature: Schema.String, graph: EffectiveGraphSchema, previous: Schema.Option(Positions) },
	messages: [Message.SucceededElkLayout, Message.FailedElkLayout],
	execute: ({ signature, graph, previous }) =>
		Effect.tryPromise(() =>
			import("@maple/ui/components/service-map/service-map-elk").then((elk) =>
				elk.layoutServiceMapWithElk(
					[...graph.nodes],
					[...graph.edges],
					{ ...DEFAULT_LAYOUT_CONFIG },
					Option.getOrUndefined(
						Option.map(previous, (positions) => new Map(Object.entries(positions))),
					),
				),
			),
		).pipe(
			Effect.map((result) =>
				Message.SucceededElkLayout({ signature, positions: Object.fromEntries(result.positions) }),
			),
			Effect.orElseSucceed(() => Message.FailedElkLayout({ signature })),
		),
})

/** The 2 s after which the synchronous layout is revealed if ELK has not answered. */
export const WaitLayoutGrace = Command.define("WaitLayoutGrace", {
	args: { signature: Schema.String },
	messages: [Message.ElapsedLayoutGrace],
	execute: ({ signature }) =>
		Effect.sleep(Duration.seconds(2)).pipe(Effect.as(Message.ElapsedLayoutGrace({ signature }))),
})

/** Two frames: the bridge's patch, then the paint that shows it. */
export const WaitBridgePaint = Command.define("WaitServiceMapBridgePaint", {
	args: { signature: Schema.String },
	messages: [Message.PaintedBridge],
	execute: ({ signature }) =>
		Effect.callback<ReturnType<typeof Message.PaintedBridge>>((resume) => {
			const handle = { id: 0 }
			handle.id = requestAnimationFrame(() => {
				handle.id = requestAnimationFrame(() =>
					resume(Effect.succeed(Message.PaintedBridge({ signature }))),
				)
			})
			return Effect.sync(() => cancelAnimationFrame(handle.id))
		}),
})

/** Coalesces a burst of camera changes into one write (`VIEWPORT_PERSIST_DEBOUNCE_MS`). */
export const WaitCameraWrite = Command.define("WaitServiceMapCameraWrite", {
	args: { version: Schema.Number },
	messages: [Message.ElapsedCameraWrite],
	execute: ({ version }) =>
		Effect.sleep(Duration.millis(400)).pipe(Effect.as(Message.ElapsedCameraWrite({ version }))),
})

// DERIVED STATE

type Prefs = Pick<Model, "minTrafficPct" | "focus" | "collapsedNamespaces">

const declutterState = (prefs: Prefs) => ({
	minTrafficPct: prefs.minTrafficPct,
	focus: Option.getOrNull(prefs.focus),
	collapsedNamespaces: [...prefs.collapsedNamespaces],
})

const exemptIds = (selectedId: Option.Option<string>): ReadonlySet<string> =>
	Option.match(selectedId, { onNone: () => new Set<string>(), onSome: (id) => new Set([id]) })

const graphOf = (model: Model): EffectiveGraph =>
	declutterGraph(model.source, declutterState(model), exemptIds(model.selectedId))

/** Where a node sits: the given positions, else the node's own position. */
export const positionOf = (
	positions: Positions,
	node: { readonly id: string; readonly position: { x: number; y: number } },
) => positions[node.id] ?? node.position

/** Layout positions, overridden by the live signature's saved drags and a drag in progress. */
const withPositions = (model: Model): Model => {
	const saved = Option.match(snapshotFor(model.snapshots, model.graph.signature), {
		onNone: () => ({}),
		onSome: (snapshot) => snapshot.positions,
	})
	const dragged = Option.match(model.drag, {
		onNone: () => ({}),
		onSome: (drag) => ({ [drag.id]: drag.position }),
	})
	return { ...model, positions: { ...model.layout.positions, ...saved, ...dragged } }
}

export const placedNodes = (model: Model) =>
	model.graph.nodes.map((node) => ({ id: node.id, position: positionOf(model.positions, node) }))

/** The namespace boxes as React Flow nodes: `fitView` frames them with the services. */
const boxTargets = (model: Model) => (canvas: Canvas.Model) =>
	namespaceBoxRects(model.graph, model.positions, canvas.measured).map((rect) => ({
		id: rect.id,
		position: rect.position,
		measured: { id: rect.id, width: rect.width, height: rect.height, handles: [] },
	}))

/** `fitView()`, or `fitView({ duration: 300 })` for the moves of a map already on screen. */
const requestMapFit = (model: Model, isAnimated: boolean): Model =>
	modifyFields(model, {
		canvas: () =>
			Canvas.requestFit(
				model.canvas,
				[...Canvas.placed(model.canvas, placedNodes(model)), ...boxTargets(model)(model.canvas)],
				isAnimated ? { ...MAP_FIT, duration: FIT_DURATION_MS } : MAP_FIT,
			),
	})

const FIT_DURATION_MS = 300

/**
 * When the map first appears with namespace boxes, its first fit is skipped: the camera stays at
 * 0,0,1. Later layouts mount their boxes while bridged, so fit.
 */
export const hasNamespaceBoxes = (graph: EffectiveGraph): boolean =>
	graph.nodes.some((node) => !node.id.startsWith(DB_NODE_PREFIX) && Boolean(node.data.namespace))

/** The automatic fit of a new layout: skipped for a saved camera and for the first boxed reveal. */
const autoFit = (model: Model, isFirstReveal: boolean): Model => {
	if (model.hasSavedCamera) return model
	const fitted = { ...model, hasFitted: true }
	return isFirstReveal && hasNamespaceBoxes(model.graph) && !model.isFirstBoxedFitKept
		? modifyFields(fitted, { canvas: (canvas) => ({ ...canvas, pendingFit: Option.none() }) })
		: requestMapFit(fitted, model.hasFitted)
}

/** The synchronous layered layout (`computeNodePositions`), anchored on what is on screen. */
const fallbackPositions = (graph: EffectiveGraph, anchor: Positions): Positions =>
	Object.fromEntries(
		computeNodePositions(
			[...graph.nodes],
			[...graph.edges],
			{ ...DEFAULT_LAYOUT_CONFIG },
			Object.keys(anchor).length === 0 ? undefined : new Map(Object.entries(anchor)),
		),
	)

/** A layout landed: show it, framed unless the signature brought its own camera. */
const reveal = (model: Model, status: LayoutStatus, positions: Positions): Model =>
	autoFit(withPositions({ ...model, layout: { status, positions }, revealed: true }), !model.revealed)

const fallBack = (model: Model, signature: string): Model =>
	signature === model.graph.signature && model.layout.status === "pending"
		? reveal(
				model,
				"fallback",
				model.fallback.signature === signature
					? model.fallback.positions
					: fallbackPositions(model.graph, model.layout.positions),
			)
		: model

const savedCameraOf = (snapshots: ReadonlyArray<Snapshot>, signature: string) =>
	Option.flatMap(snapshotFor(snapshots, signature), (snapshot) => Option.fromNullishOr(snapshot.viewport))

/** The 65 / 35 split when a node opens the panel (as react-resizable-panels lays it out). */
const DETAIL_SPLIT = [64.999, 35.001]

const withSelection = (model: Model, selectedId: Option.Option<string>): Model => {
	const wasOpen = Option.isSome(model.selectedId)
	const isOpen = Option.isSome(selectedId)
	const layout = wasOpen === isOpen ? model.split.layout : isOpen ? DETAIL_SPLIT : [100]
	return { ...model, selectedId, split: { ...model.split, layout } }
}

/**
 * A new effective graph. Same signature: metrics or dimming changed, positions stay. New signature:
 * keep every known node where it is and place new ones by the anchored fallback while ELK runs
 * (the bridge), restoring that signature's saved camera if it has one.
 */
const applyGraph = (model: Model, graph: EffectiveGraph): Return => {
	if (graph.signature === model.graph.signature) return { model: withPositions({ ...model, graph }) }
	const savedCamera = savedCameraOf(model.snapshots, graph.signature)
	const anchor = model.layout.positions
	// One synchronous layout per signature: the bridge places
	// new nodes by it, and it is the layout shown if ELK fails or is late.
	const fallback = fallbackPositions(graph, anchor)
	const positions = model.revealed ? { ...fallback, ...anchor } : anchor
	const next = withPositions({
		...model,
		graph,
		layout: { status: "pending", positions },
		fallback: { signature: graph.signature, positions: fallback },
		hasSavedCamera: Option.isSome(savedCamera),
		canvas: Option.match(savedCamera, {
			onNone: () => model.canvas,
			onSome: (viewport) => ({ ...model.canvas, viewport }),
		}),
	})
	// The bridge is not fitted: ELK's answer lands a frame later and only that one frames.
	const bridged = next.revealed
		? awaitBridgePaint({
				...next,
				bridge: Option.some({ signature: graph.signature, isAwaitingPaint: false }),
				canvas: { ...next.canvas, pendingFit: Option.none() },
			})
		: { model: next, commands: [] }
	return {
		model: bridged.model,
		commands: [
			...(bridged.commands ?? []),
			RunElkLayout({
				signature: graph.signature,
				graph,
				previous: Object.keys(anchor).length === 0 ? Option.none() : Option.some(anchor),
			}),
			WaitLayoutGrace({ signature: graph.signature }),
		],
	}
}

/**
 * Declutter again after an input changed. A focus target that left the graph clears, and a
 * selected node that collapse or focus-hide removed is deselected.
 */
const redeclutter = (model: Model): Return => {
	const first = graphOf(model)
	const unfocused =
		first.declutter.focusMissing && Option.isSome(model.focus)
			? { ...model, focus: Option.none() }
			: model
	const graph = unfocused === model ? first : graphOf(unfocused)
	const isSelectionGone = Option.match(unfocused.selectedId, {
		onNone: () => false,
		onSome: (id) => !graph.nodes.some((node) => node.id === id),
	})
	if (!isSelectionGone) return applyGraph(unfocused, graph)
	const deselected = withSelection(unfocused, Option.none())
	return applyGraph(deselected, graphOf(deselected))
}

export interface MapConfig {
	readonly minTrafficPct: number
	readonly focus: Option.Option<Focus>
	readonly collapsedNamespaces?: ReadonlyArray<string>
	/** Persisted drags and cameras (`serviceMapLayoutAtomFamily`). */
	readonly snapshots?: ReadonlyArray<Snapshot>
	/** Fit the first reveal even with namespace boxes (see `hasNamespaceBoxes`); default false. */
	readonly isFirstBoxedFitKept?: boolean
}

export const init = (source: SourceGraph, config: MapConfig): Return => {
	const prefs: Prefs = {
		minTrafficPct: config.minTrafficPct,
		focus: config.focus,
		collapsedNamespaces: config.collapsedNamespaces ?? DEFAULT_VIEW_PREFS.collapsedNamespaces,
	}
	const graph = declutterGraph(source, declutterState(prefs), new Set())
	const snapshots = config.snapshots ?? []
	const savedCamera = savedCameraOf(snapshots, graph.signature)
	const canvas = Canvas.init({ minZoom: 0.05, maxZoom: 2, fitOnInit: Option.none() })
	const model: Model = {
		source,
		graph,
		...prefs,
		layout: { status: "pending", positions: {} },
		fallback: { signature: "", positions: {} },
		revealed: false,
		selectedId: Option.none(),
		colorMode: "service",
		reducedMotion: true,
		canvas: Option.match(savedCamera, {
			onNone: () => canvas,
			onSome: (viewport) => ({ ...canvas, viewport }),
		}),
		snapshots,
		hasFitted: false,
		isFirstBoxedFitKept: config.isFirstBoxedFitKept ?? false,
		hasSavedCamera: Option.isSome(savedCamera),
		positions: {},
		drag: Option.none(),
		bridge: Option.none(),
		heldLayout: Option.none(),
		cameraWrite: 0,
		toolbar: Toolbar.init(),
		legend: Popover.init("service-map-legend", { align: "start", side: "top" }),
		split: Resizable.init("service-map-split", "horizontal", [100]),
	}
	// A focus target missing from the first graph clears like any later one.
	const settled =
		graph.declutter.focusMissing && Option.isSome(prefs.focus) ? redeclutter(model).model : model
	return {
		model: withPositions(settled),
		commands: [
			RunElkLayout({
				signature: settled.graph.signature,
				graph: settled.graph,
				previous: Option.none(),
			}),
			WaitLayoutGrace({ signature: settled.graph.signature }),
		],
	}
}

/** The URL's focus (the route owns it); a no-op when it already matches. */
export const setFocus = (model: Model, focus: Option.Option<Focus>): Return =>
	sameFocus(model.focus, focus) ? { model } : redeclutter({ ...model, focus })

/** New rows from a refresh or an overlay landing: same nodes refine in place, new topology relayouts. */
export const setSource = (model: Model, source: SourceGraph): Return => redeclutter({ ...model, source })

// UPDATE

const toggleSelection = (model: Model, nodeId: string): Return =>
	redeclutter(
		withSelection(model, Option.contains(model.selectedId, nodeId) ? Option.none() : Option.some(nodeId)),
	)

/** A node click: a collapsed namespace expands back into its services, anything else toggles selection. */
const clickedNode = (model: Model, nodeId: string): Return => {
	if (!isNsAggregateId(nodeId)) return toggleSelection(model, nodeId)
	const namespace = decodeURIComponent(nodeId.slice(NS_AGGREGATE_PREFIX.length))
	return redeclutter({
		...model,
		collapsedNamespaces: model.collapsedNamespaces.filter((name) => name !== namespace),
	})
}

/** `onSelect` of the 3D view: a collapsed namespace expands, anything else becomes the selection. */
const pickedNode = (model: Model, nodeId: string | null): Return => {
	if (nodeId !== null && isNsAggregateId(nodeId)) return clickedNode(model, nodeId)
	if (Option.getOrNull(model.selectedId) === nodeId) return { model }
	return redeclutter(withSelection(model, nodeId === null ? Option.none() : Option.some(nodeId)))
}

const canvasMessage = (model: Model, message: Canvas.Message): Return =>
	Canvas.Message.match<Return>(message, {
		DraggedNode: ({ id, position }) => ({
			model: withPositions({ ...model, drag: Option.some({ id, position }) }),
		}),
		// Finished drags persist, keyed by node id, under the live signature.
		EndedNodeDrag: ({ id, position }) => ({
			model: withPositions({
				...model,
				drag: Option.none(),
				snapshots: upsert(model.snapshots, model.graph.signature, (snapshot) => ({
					...snapshot,
					positions: { ...snapshot.positions, [id]: position },
				})),
			}),
		}),
		EndedViewportMove: () => scheduleCameraWrite({ model }),
		ChangedViewport: () => passToCanvas(model, message),
		ResizedPane: () => passToCanvas(model, message),
		MeasuredNodes: () => {
			const measured = passToCanvas(model, message)
			const waiting = awaitBridgePaint(measured.model)
			return {
				model: waiting.model,
				commands: [...(measured.commands ?? []), ...(waiting.commands ?? [])],
			}
		},
		ClickedZoomIn: () => passToCanvas(model, message),
		ClickedZoomOut: () => passToCanvas(model, message),
		ClickedFitView: () => passToCanvas(model, message),
	})

/** Once every node of the bridge is measured, wait for the frame that paints it. */
const awaitBridgePaint = (model: Model): Return => {
	if (Option.isNone(model.bridge) || model.bridge.value.isAwaitingPaint) return { model }
	const isMeasured = model.graph.nodes.every((node) => model.canvas.measured[node.id] !== undefined)
	if (!isMeasured) return { model }
	const { signature } = model.bridge.value
	return {
		model: { ...model, bridge: Option.some({ signature, isAwaitingPaint: true }) },
		commands: [WaitBridgePaint({ signature })],
	}
}

const passToCanvas = (model: Model, message: Canvas.Message): Return => ({
	model: modifyFields(model, {
		canvas: () => Canvas.update(model.canvas, message, placedNodes(model), boxTargets(model)),
	}),
})

/** `onMoveEnd`: the last camera of a burst is written 400 ms later. */
const scheduleCameraWrite = (result: Return): Return => {
	const version = result.model.cameraWrite + 1
	return {
		model: { ...result.model, cameraWrite: version },
		commands: [...(result.commands ?? []), WaitCameraWrite({ version })],
	}
}

/** A fit moved the camera: React Flow reports that as a move end too. */
const afterFits = (before: Model, result: Return): Return =>
	result.model.canvas.fitsApplied === before.canvas.fitsApplied ? result : scheduleCameraWrite(result)

const withSelectMessage = (
	select: Select.Model,
	message: Select.Message,
	write: (next: Select.Model) => Model,
	wrap: (message: Select.Message) => Message,
	onValue: (model: Model, value: string) => Return,
): Return => {
	const next = Select.update(select, message)
	const model = write(next.model)
	const changed = next.outMessage === undefined ? { model } : onValue(model, next.outMessage.value)
	return {
		...changed,
		commands: [...Command.mapMessages(next.commands ?? [], wrap), ...(changed.commands ?? [])],
	}
}

const isColorMode = Schema.is(ColorMode)

const withFocus = (model: Model, focus: Option.Option<Focus>): Return => redeclutter({ ...model, focus })

const step = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotCanvasMessage: ({ message: inner }) => canvasMessage(model, inner),
		SucceededElkLayout: ({ signature, positions }) => ({
			model:
				signature !== model.graph.signature
					? model
					: Option.exists(model.bridge, (bridge) => bridge.signature === signature)
						? {
								...model,
								heldLayout: Option.some({ signature, status: "ready" as const, positions }),
							}
						: reveal(model, "ready", positions),
		}),
		// A failure lands after the bridge's frame too; the signature's fallback shows then.
		FailedElkLayout: ({ signature }) =>
			Option.exists(model.bridge, (bridge) => bridge.signature === signature) &&
			model.fallback.signature === signature
				? {
						model: {
							...model,
							heldLayout: Option.some({
								signature,
								status: "fallback" as const,
								positions: model.fallback.positions,
							}),
						},
					}
				: { model: fallBack(model, signature) },
		ElapsedLayoutGrace: ({ signature }) => ({ model: fallBack(model, signature) }),
		PaintedBridge: ({ signature }) => {
			if (!Option.exists(model.bridge, (bridge) => bridge.signature === signature)) return { model }
			const cleared = { ...model, bridge: Option.none(), heldLayout: Option.none() }
			return {
				model: Option.match(model.heldLayout, {
					onNone: () => cleared,
					onSome: (held) =>
						held.signature === model.graph.signature
							? reveal(cleared, held.status, held.positions)
							: cleared,
				}),
			}
		},
		ClickedNode: ({ nodeId }) => clickedNode(model, nodeId),
		PickedNode: ({ nodeId }) => pickedNode(model, nodeId),
		ClickedPane: () =>
			Option.isNone(model.selectedId) ? { model } : redeclutter(withSelection(model, Option.none())),
		// "Re-sort": drop this signature's drags and camera, snap back to the layout and fit it.
		ClickedResort: () => {
			const reset = withPositions({
				...model,
				hasSavedCamera: false,
				snapshots: model.snapshots.filter((s) => s.signature !== model.graph.signature),
			})
			return { model: requestMapFit(reset, true) }
		},
		ChangedReducedMotion: ({ reduced }) => ({ model: { ...model, reducedMotion: reduced } }),
		CompletedMountParticles: () => ({ model }),
		ClickedCollapseNamespace: ({ namespace }) =>
			model.collapsedNamespaces.includes(namespace)
				? { model }
				: redeclutter({ ...model, collapsedNamespaces: [...model.collapsedNamespaces, namespace] }),
		// The combobox comes back fresh.
		ClickedClearFocus: () =>
			withFocus(
				{
					...model,
					toolbar: {
						...model.toolbar,
						focusCombobox: Combobox.init(Toolbar.FOCUS_COMBOBOX_ID, "single"),
					},
				},
				Option.none(),
			),
		ClickedToggleHideRest: () =>
			withFocus(
				model,
				Option.map(model.focus, (focus) => ({
					...focus,
					mode: focus.mode === "hide" ? "dim" : "hide",
				})),
			),
		ClickedShowAllTraffic: () => redeclutter({ ...model, minTrafficPct: 0 }),
		ClickedResetFilters: () => redeclutter({ ...model, minTrafficPct: 0, focus: Option.none() }),
		ClickedCloseDetail: () => redeclutter(withSelection(model, Option.none())),
		ClickedFocusSelected: () =>
			withFocus(
				model,
				Option.map(model.selectedId, (serviceId) => ({ serviceId, hops: 1, mode: "dim" })),
			),
		ElapsedCameraWrite: ({ version }) =>
			version !== model.cameraWrite
				? { model }
				: {
						model: {
							...model,
							snapshots: upsert(model.snapshots, model.graph.signature, (snapshot) => ({
								...snapshot,
								viewport: model.canvas.viewport,
							})),
						},
					},
		GotFocusComboboxMessage: ({ message: inner }) => {
			const next = Combobox.update(model.toolbar.focusCombobox, inner)
			const withCombobox = { ...model, toolbar: { ...model.toolbar, focusCombobox: next.model } }
			const commands = Command.mapMessages(next.commands ?? [], (m) =>
				Message.GotFocusComboboxMessage({ message: m }),
			)
			const picked =
				next.outMessage?._tag === "ChangedValue" && next.outMessage.value.length > 0
					? next.outMessage.value
					: null
			if (picked === null) return { model: withCombobox, commands }
			const focused = withFocus(withCombobox, Option.some({ serviceId: picked, hops: 1, mode: "dim" }))
			return { ...focused, commands: [...commands, ...(focused.commands ?? [])] }
		},
		GotTrafficSelectMessage: ({ message: inner }) =>
			withSelectMessage(
				model.toolbar.trafficSelect,
				inner,
				(trafficSelect) => ({ ...model, toolbar: { ...model.toolbar, trafficSelect } }),
				(m) => Message.GotTrafficSelectMessage({ message: m }),
				(next, value) => redeclutter({ ...next, minTrafficPct: Number(value) }),
			),
		GotColorSelectMessage: ({ message: inner }) =>
			withSelectMessage(
				model.toolbar.colorSelect,
				inner,
				(colorSelect) => ({ ...model, toolbar: { ...model.toolbar, colorSelect } }),
				(m) => Message.GotColorSelectMessage({ message: m }),
				(next, value) => ({ model: isColorMode(value) ? { ...next, colorMode: value } : next }),
			),
		GotDepthSelectMessage: ({ message: inner }) =>
			withSelectMessage(
				model.toolbar.depthSelect,
				inner,
				(depthSelect) => ({ ...model, toolbar: { ...model.toolbar, depthSelect } }),
				(m) => Message.GotDepthSelectMessage({ message: m }),
				(next, value) =>
					withFocus(
						next,
						Option.map(next.focus, (focus) => ({ ...focus, hops: Number(value) === 2 ? 2 : 1 })),
					),
			),
		GotTooltipMessage: ({ message: inner }) => {
			const next = Tooltip.update(model.toolbar.tooltip, inner)
			return {
				model: { ...model, toolbar: { ...model.toolbar, tooltip: next.model } },
				commands: Command.mapMessages(next.commands ?? [], (m) =>
					Message.GotTooltipMessage({ message: m }),
				),
			}
		},
		GotLegendMessage: ({ message: inner }) => {
			const next = Popover.update(model.legend, inner)
			return {
				model: { ...model, legend: next.model },
				commands: Command.mapMessages(next.commands ?? [], (m) =>
					Message.GotLegendMessage({ message: m }),
				),
			}
		},
		GotSplitMessage: ({ message: inner }) => {
			const next = Resizable.update(model.split, inner)
			return {
				model: { ...model, split: next.model },
				commands: Command.mapMessages(next.commands ?? [], (m) =>
					Message.GotSplitMessage({ message: m }),
				),
			}
		},
	})

export const update = (model: Model, message: Message): Return => afterFits(model, step(model, message))
