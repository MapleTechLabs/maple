import { formatErrorRate } from "@maple/ui/lib/format"
import { button } from "@maple/views/ui/button"
import { badge } from "@maple/views/ui/display"
import { pressable } from "@maple/views/ui/pressable"
import { hstack, vstack } from "@maple/views/ui/stack"
import { statusDot } from "@maple/views/ui/status-dot"
import { typography } from "@maple/views/ui/typography"
import { Array as Arr, Effect, Schema, String as Str } from "effect"
import type { Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { pageBody, pageContent } from "../page/kit/dashboard-page"
import { formatLatency, formatRate } from "../page/service-map/three/spatial-layout"
import type { Node3D } from "../page/service-map/three/types"
import { biomeOf } from "../page/service-map/tiles/biome"
import type { Link, LinkState, Placements } from "../page/service-map/tiles/board"
import * as Tiles from "../page/service-map/tiles/update"
import {
	type Board,
	boardOf,
	healthDot,
	KIND_LABEL,
	labelOf,
	mapColumn,
	sortedLinks,
	STATE_LABEL,
} from "../page/service-map/tiles/view"
import type { Resources } from "../platform/resources"
import { SERVICE_MAP_3D_TOPOLOGY } from "./service-map-3d/fixture"

// `/lab/service-map-tiles`: the tile map over the sample topology, with a side rail of
// connections (or the selected service's) where the page has its service panel.

const topology = SERVICE_MAP_3D_TOPOLOGY

export const Model = Schema.Struct({
	tiles: Tiles.Model,
	selectedId: Schema.NullOr(Schema.String),
	reducedMotion: Schema.Boolean,
})
export type Model = typeof Model.Type

export const Message = Tiles.Message
export type Message = Tiles.Message

export const Flags = Schema.Struct({ reducedMotion: Schema.Boolean })
export type Flags = typeof Flags.Type

export const flags = Effect.sync((): Flags => ({
	reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
}))

type Return = Update.Return<Model, Message, Resources>

export const init = (flags: Flags): Return => ({
	model: {
		tiles: Tiles.sync(Tiles.init(), topology),
		selectedId: null,
		reducedMotion: flags.reducedMotion,
	},
})

export const update = (model: Model, message: Message): Return => {
	const next = Tiles.update(model.tiles, message, topology)
	return {
		model: {
			...model,
			tiles: next.model,
			selectedId: next.outMessage === undefined ? model.selectedId : next.outMessage.nodeId,
		},
	}
}

type H = HtmlBuilder<Message>

const KIND_BUILDING = {
	edge: "a lighthouse by a pond",
	service: "a village",
	database: "an observatory",
	queue: "a windmill",
	external: "a keep",
} as const

const ROW_CLASS =
	"flex w-full flex-col gap-1 px-4 py-2 text-left hover:bg-surface-strong active:bg-surface-strong focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2"

const linkRow = (h: H, board: Board, link: Link, state: LinkState, towards: string): Html =>
	pressable(
		h,
		{
			onClick: Message.PickedNode({ nodeId: towards }),
			className: ROW_CLASS,
			attributes: [h.Key(link.id)],
		},
		[
			hstack(h, { gap: "2", align: "center", className: "w-full" }, [
				healthDot(h, link.errorRate),
				typography(h, { size: "xs", truncate: true, className: "min-w-0 flex-1" }, [
					`${labelOf(board, link.source)} → ${labelOf(board, link.target)}`,
				]),
				badge(h, { variant: state === "road" ? "secondary" : "outline", size: "sm" }, [
					STATE_LABEL[state],
				]),
			]),
			typography(h, { size: "2xs", tone: "muted", numeric: true, className: "pl-3.5" }, [
				`${formatRate(link.callsPerSecond)} · ${formatErrorRate(link.errorRate)} errors`,
			]),
		],
	)

const RAIL_CLASS =
	"flex max-h-120 min-h-80 flex-col overflow-y-auto border-t bg-background xl:max-h-none xl:min-h-0 xl:border-t-0 xl:border-l"

const inspector = (h: H, board: Board, cells: Placements, node: Node3D): Html => {
	const own = sortedLinks(
		cells,
		Arr.filter(board.links, (link) => link.source === node.id || link.target === node.id),
	)
	const biome = biomeOf(board.biomes, node.namespace)
	return h.aside(
		[h.Class(RAIL_CLASS), h.AriaLabel("Service inspector")],
		[
			vstack(h, { gap: "2", className: "border-b p-4" }, [
				button(
					h,
					{
						variant: "ghost",
						size: "xs",
						className: "-ml-2 self-start text-muted-foreground",
						attributes: [h.OnClick(Message.PickedNode({ nodeId: null }))],
					},
					["← All connections"],
				),
				hstack(h, { gap: "2", align: "center" }, [
					healthDot(h, node.errorRate),
					typography(h, { size: "sm", weight: "semibold", className: "min-w-0 break-all" }, [
						node.label,
					]),
				]),
				typography(h, { size: "xs", tone: "muted", as: "p" }, [
					`${KIND_LABEL[node.kind]} in ${node.namespace}: ${KIND_BUILDING[node.kind]} in ${Str.toLowerCase(biome.label)} country, sending ${biome.produce.label}`,
				]),
			]),
			h.dl(
				[h.Class("grid grid-cols-3 gap-3 border-b p-4")],
				Arr.map(
					[
						["Throughput", formatRate(node.throughput)],
						["Errors", formatErrorRate(node.errorRate)],
						["p95", formatLatency(node.p95LatencyMs)],
					] as const,
					([term, value]) =>
						h.div(
							[h.Key(term)],
							[
								h.dt([], [typography(h, { size: "2xs", tone: "muted" }, [term])]),
								h.dd([], [typography(h, { size: "sm", numeric: true }, [value])]),
							],
						),
				),
			),
			typography(h, { size: "xs", tone: "muted", as: "p", className: "px-4 pt-4 pb-2" }, [
				`${own.length} connections`,
			]),
			...Arr.map(own, ({ link, state }) =>
				linkRow(h, board, link, state, link.source === node.id ? link.target : link.source),
			),
		],
	)
}

/** Which country each namespace is, and what its tiles send down the road. */
const biomeLegend = (h: H, board: Board): Html =>
	vstack(h, { gap: "1.5", className: "border-b p-4", attributes: [h.AriaLabel("Namespaces")] }, [
		typography(h, { size: "xs", weight: "semibold" }, ["Namespaces"]),
		...Arr.map([...board.biomes], ([namespace, biome]) =>
			hstack(h, { gap: "2", align: "center", attributes: [h.Key(namespace)] }, [
				statusDot(h, {
					tone: "custom",
					attributes: [h.Style({ "background-color": biome.swatch })],
				}),
				typography(h, { size: "xs", truncate: true, className: "min-w-0 flex-1" }, [namespace]),
				typography(h, { size: "2xs", tone: "muted", className: "whitespace-nowrap" }, [
					`${biome.label} · ${biome.produce.label}`,
				]),
			]),
		),
	])

const connections = (h: H, board: Board, cells: Placements): Html => {
	const all = sortedLinks(cells, board.links)
	const rails = Arr.filter(all, (entry) => entry.state === "rail").length
	return h.aside(
		[h.Class(RAIL_CLASS), h.AriaLabel("Connections")],
		[
			vstack(h, { gap: "1", className: "border-b p-4" }, [
				typography(h, { size: "xs", weight: "semibold" }, ["Connections"]),
				typography(h, { size: "2xs", tone: "muted", as: "p" }, [
					rails === 0
						? "Every connection on the board goes by road."
						: `${rails} still go by rail. Rearrange to put their tiles side by side.`,
				]),
			]),
			biomeLegend(h, board),
			...Arr.map(all, ({ link, state }) => linkRow(h, board, link, state, link.source)),
		],
	)
}

export const view = (model: Model, h: H): Html => {
	const board = boardOf(topology)
	const cells = Tiles.placementsOf(model.tiles)
	const selected = model.selectedId === null ? undefined : board.nodesById.get(model.selectedId)
	return pageBody(h, [
		pageContent(h, [
			h.div(
				[
					h.Class(
						"grid h-full min-h-0 grid-cols-1 overflow-y-auto xl:grid-cols-[minmax(0,1fr)_288px] xl:overflow-hidden",
					),
				],
				[
					h.div(
						[h.Class("h-[640px] min-h-0 xl:h-auto")],
						[
							mapColumn(
								model.tiles,
								{
									topology,
									selectedId: model.selectedId,
									reducedMotion: model.reducedMotion,
								},
								h,
							),
						],
					),
					selected === undefined
						? connections(h, board, cells)
						: inspector(h, board, cells, selected),
				],
			),
		]),
	])
}
