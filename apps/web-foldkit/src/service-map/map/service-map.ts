import type { DeclutterFocus } from "@maple/ui/components/service-map/service-map-declutter"
import { computeNodePositions, DEFAULT_LAYOUT_CONFIG } from "@maple/ui/components/service-map/service-map-utils"
import { Duration, Effect, Option, Schema } from "effect"
import { Command, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { modifyFields } from "foldkit/struct"
import * as Canvas from "../xyflow/canvas"
import { declutterGraph, type EffectiveGraph, EffectiveGraphSchema, type SourceGraph, SourceGraphSchema } from "./graph"

/**
 * `ServiceMapFlowCanvas` (packages/ui `service-map/service-map-canvas.tsx`) as a Submodel:
 * declutter, ELK layout in a worker with the synchronous layout as a 2 s fallback, selection,
 * colour mode, and the React Flow canvas state.
 */

const XY = Schema.Struct({ x: Schema.Number, y: Schema.Number })
const Positions = Schema.Record(Schema.String, XY)
export type Positions = typeof Positions.Type

export const LayoutStatus = Schema.Literals(["pending", "fallback", "ready"])
export type LayoutStatus = typeof LayoutStatus.Type

export const ColorMode = Schema.Literals(["service", "health", "platform"])

export const Model = Schema.Struct({
	source: SourceGraphSchema,
	graph: EffectiveGraphSchema,
	focus: Schema.Option(Schema.Struct({ serviceId: Schema.String, hops: Schema.Literals([1, 2]), mode: Schema.Literals(["dim", "hide"]) })),
	minTrafficPct: Schema.Number,
	/** ELK's answer, or the synchronous stand-in it is replaced by after the grace period. */
	layout: Schema.Struct({ status: LayoutStatus, positions: Positions }),
	/** The first final or fallback layout has been shown; later recomputes keep the map visible. */
	revealed: Schema.Boolean,
	selectedId: Schema.Option(Schema.String),
	colorMode: ColorMode,
	/** `prefers-reduced-motion`; the particle canvas is not rendered while it applies. */
	reducedMotion: Schema.Boolean,
	canvas: Canvas.Model,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	GotCanvasMessage: { message: Canvas.Message },
	SucceededElkLayout: { signature: Schema.String, positions: Positions },
	FailedElkLayout: { signature: Schema.String },
	ElapsedLayoutGrace: { signature: Schema.String },
	ClickedNode: { nodeId: Schema.String },
	ClickedPane: {},
	ClickedResort: {},
	ChangedReducedMotion: { reduced: Schema.Boolean },
	CompletedMountParticles: {},
})
export type Message = typeof Message.Type

/** Default `fitView()` of the map: padding 0.1 inside the canvas's zoom range. */
export const MAP_FIT: Canvas.FitRequest = { padding: 0.1, minZoom: 0.05, maxZoom: 2 }

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
					Option.getOrUndefined(Option.map(previous, (positions) => new Map(Object.entries(positions)))),
				),
			),
		).pipe(
			Effect.map((result) => Message.SucceededElkLayout({ signature, positions: Object.fromEntries(result.positions) })),
			Effect.orElseSucceed(() => Message.FailedElkLayout({ signature })),
		),
})

export interface MapConfig {
	readonly minTrafficPct: number
	readonly focus: Option.Option<DeclutterFocus>
}

const declutterState = (minTrafficPct: number, focus: Model["focus"]) => ({
	minTrafficPct,
	focus: Option.getOrNull(focus),
	collapsedNamespaces: [],
})

const exemptIds = (selectedId: Option.Option<string>): ReadonlySet<string> =>
	Option.match(selectedId, { onNone: () => new Set<string>(), onSome: (id) => new Set([id]) })

export const init = (source: SourceGraph, config: MapConfig): Update.Return<Model, Message> => {
	const graph = declutterGraph(source, declutterState(config.minTrafficPct, config.focus), new Set())
	return {
		model: {
			source,
			graph,
			focus: config.focus,
			minTrafficPct: config.minTrafficPct,
			layout: { status: "pending", positions: {} },
			revealed: false,
			selectedId: Option.none(),
			colorMode: "service",
			reducedMotion: true,
			canvas: Canvas.init({ minZoom: 0.05, maxZoom: 2, fitOnInit: Option.none() }),
		},
		commands: [
			RunElkLayout({ signature: graph.signature, graph, previous: Option.none() }),
			WaitLayoutGrace({ signature: graph.signature }),
		],
	}
}

/** Where a node sits: the current layout, else the node's own position. */
export const positionOf = (positions: Positions, node: { readonly id: string; readonly position: { x: number; y: number } }) =>
	positions[node.id] ?? node.position

export const placedNodes = (model: Model) =>
	model.graph.nodes.map((node) => ({ id: node.id, position: positionOf(model.layout.positions, node) }))

const reveal = (model: Model, status: LayoutStatus, positions: Positions): Model => {
	const next = modifyFields(model, { layout: () => ({ status, positions }), revealed: () => true })
	return modifyFields(next, {
		canvas: () => Canvas.requestFit(next.canvas, Canvas.placed(next.canvas, placedNodes(next)), MAP_FIT),
	})
}

/** The synchronous layered layout (`computeNodePositions`), the timeout and error fallback. */
const fallbackPositions = (graph: EffectiveGraph): Positions =>
	Object.fromEntries(computeNodePositions([...graph.nodes], [...graph.edges], { ...DEFAULT_LAYOUT_CONFIG }))

/** A selection change can change what the traffic filter exempts, and with it the layout. */
const reselect = (model: Model, selectedId: Option.Option<string>): Update.Return<Model, Message> => {
	const graph = declutterGraph(model.source, declutterState(model.minTrafficPct, model.focus), exemptIds(selectedId))
	const next = modifyFields(model, { selectedId: () => selectedId })
	if (graph.signature === model.graph.signature) return { model: next }
	return {
		model: modifyFields(next, { graph: () => graph, layout: (layout) => ({ ...layout, status: "pending" as const }) }),
		commands: [
			RunElkLayout({ signature: graph.signature, graph, previous: Option.some(model.layout.positions) }),
			WaitLayoutGrace({ signature: graph.signature }),
		],
	}
}

const fallBack = (model: Model, signature: string): Model =>
	signature === model.graph.signature && model.layout.status === "pending"
		? reveal(model, "fallback", fallbackPositions(model.graph))
		: model

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
	Message.match(message, {
		GotCanvasMessage: ({ message: canvasMessage }) => ({
			model: modifyFields(model, { canvas: () => Canvas.update(model.canvas, canvasMessage, placedNodes(model)) }),
		}),
		SucceededElkLayout: ({ signature, positions }) => ({
			model: signature === model.graph.signature ? reveal(model, "ready", positions) : model,
		}),
		FailedElkLayout: ({ signature }) => ({ model: fallBack(model, signature) }),
		ElapsedLayoutGrace: ({ signature }) => ({ model: fallBack(model, signature) }),
		ClickedNode: ({ nodeId }) =>
			reselect(model, Option.contains(model.selectedId, nodeId) ? Option.none() : Option.some(nodeId)),
		ClickedPane: () => (Option.isNone(model.selectedId) ? { model } : reselect(model, Option.none())),
		ClickedResort: () => ({
			model: modifyFields(model, {
				canvas: () => Canvas.requestFit(model.canvas, Canvas.placed(model.canvas, placedNodes(model)), MAP_FIT),
			}),
		}),
		ChangedReducedMotion: ({ reduced }) => ({ model: modifyFields(model, { reducedMotion: () => reduced }) }),
		CompletedMountParticles: () => ({ model }),
	})

/** The 2 s after which the synchronous layout is revealed if ELK has not answered. */
export const WaitLayoutGrace = Command.define("WaitLayoutGrace", {
	args: { signature: Schema.String },
	messages: [Message.ElapsedLayoutGrace],
	execute: ({ signature }) =>
		Effect.sleep(Duration.seconds(2)).pipe(Effect.as(Message.ElapsedLayoutGrace({ signature }))),
})
