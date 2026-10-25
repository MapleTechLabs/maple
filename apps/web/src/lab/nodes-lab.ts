import { buildNodeCatalogue } from "./node-catalogue/node-catalogue"
import { Clock, Effect, Option, Schema } from "effect"
import { Command, Submodel, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { load } from "foldkit/navigation"
import { Message as InvestigationMessage } from "../page/investigations/detail/message"
import { edgeLabel, edgeView, nodeChildren } from "../page/investigations/detail/view-canvas"
import { dashboardPage } from "../page/kit/dashboard-page"
import * as Canvas from "../service-map/xyflow/canvas"
import { edgesLayer, flowCanvas, flowNode, nodesLayer } from "../service-map/xyflow/view"

// `/lab/nodes`: every
// provenance-canvas node and edge state in the investigation page's renderer, at 1:1.

const CATALOGUE = buildNodeCatalogue()
/** Breathing room around the grid, and the offset the default viewport opens at. */
const PAD = 24

export const Model = Schema.Struct({
	nowMs: Schema.Number,
	timeZone: Schema.String,
	canvas: Canvas.Model,
})
export type Model = typeof Model.Type

/** The cards are the investigation page's: its canvas and link Messages are the ones acted on. */
export const Message = defineMessageUnion({
	GotInvestigationMessage: { message: InvestigationMessage },
	CompletedLoadNodeLink: {},
})
export type Message = typeof Message.Type

/** A card's link leaves the studio for the page it names. */
const LoadNodeLink = Command.define("LoadNodeLinkFromLab", {
	args: { href: Schema.String },
	messages: [Message.CompletedLoadNodeLink],
	execute: ({ href }) => Effect.as(load(href), Message.CompletedLoadNodeLink()),
})

export const Flags = Schema.Struct({ nowMs: Schema.Number, timeZone: Schema.String })
export type Flags = typeof Flags.Type

export const flags: Effect.Effect<Flags> = Effect.all({
	nowMs: Clock.currentTimeMillis,
	timeZone: Effect.sync(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
})

/** `defaultViewport={{ x: PAD, y: PAD, zoom: 1 }}`, `minZoom={0.2}`, `maxZoom={1.5}`. */
export const init = (flags: Flags) => ({
	model: {
		...flags,
		canvas: {
			...Canvas.init({ minZoom: 0.2, maxZoom: 1.5, fitOnInit: Option.none() }),
			viewport: { x: PAD, y: PAD, zoom: 1 },
		},
	},
})

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
	Message.match<Update.Return<Model, Message>>(message, {
		GotInvestigationMessage: ({ message: inner }) => {
			if (inner._tag === "GotCanvasMessage")
				return { model: { ...model, canvas: Canvas.update(model.canvas, inner.message, []) } }
			if (inner._tag === "ClickedNodeLink")
				return { model, commands: [LoadNodeLink({ href: inner.href })] }
			return { model }
		},
		CompletedLoadNodeLink: () => ({ model }),
	})

type CanvasInputs = Readonly<{ nowMs: number; timeZone: string }>

const ANCHORS = new Map(CATALOGUE.nodes.map((node) => [node.id, node]))
const someOf = <A>(value: A | null) => Option.toArray(Option.fromNullishOr(value))

/** `<ReactFlow>` over the catalogue: `nodeTypes`/`edgeTypes` are the investigation canvas's own. */
const canvasView = Submodel.defineView<Canvas.Model, InvestigationMessage, CanvasInputs>(
	(canvas, inputs, h) =>
		flowCanvas(h, {
			model: canvas,
			toMessage: (message) => InvestigationMessage.GotCanvasMessage({ message }),
			edges: edgesLayer(
				h,
				CATALOGUE.edges.flatMap((edge) => someOf(edgeView(h, edge, ANCHORS))),
			),
			edgeLabels: CATALOGUE.edges.flatMap((edge) => someOf(edgeLabel(h, edge, ANCHORS))),
			nodes: nodesLayer(
				h,
				CATALOGUE.nodes.map((node) =>
					flowNode(h, {
						id: node.id,
						type: node.type,
						position: node.position,
						measured: true,
						style: {
							width: `${node.width}px`,
							height: `${node.height}px`,
							"pointer-events": "all",
						},
						children: nodeChildren(h, node, inputs),
					}),
				),
			),
			panels: [],
		}),
)

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	dashboardPage(h, {}, [
		h.div(
			[h.Class("flex flex-col")],
			[
				h.div(
					[h.Class("border-b px-4 py-3")],
					[
						h.h1([h.Class("text-sm font-semibold")], ["Node Lab"]),
						h.p(
							[h.Class("text-xs text-muted-foreground")],
							[
								"Every provenance-canvas node and edge state, in the production renderer, at 1:1. Scroll the page; pan and zoom inside the canvas.",
							],
						),
					],
				),
				h.div(
					[h.Style({ height: `${CATALOGUE.height + PAD * 2}px`, width: "100%" })],
					[
						h.submodel({
							slotId: "node-catalogue-canvas",
							model: model.canvas,
							view: canvasView,
							viewInputs: { nowMs: model.nowMs, timeZone: model.timeZone },
							toParentMessage: (message: InvestigationMessage) =>
								Message.GotInvestigationMessage({ message }),
						}),
					],
				),
			],
		),
	])
