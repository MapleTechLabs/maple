import { formatErrorRate } from "@maple/ui/lib/format"
import { encodeJson } from "@maple/views/data/request-key"
import { button } from "@maple/views/ui/button"
import { badge } from "@maple/views/ui/display"
import { icon } from "@maple/views/ui/icon"
import { iconButton } from "@maple/views/ui/icon-button"
import { layer } from "@maple/views/ui/layer"
import { meter } from "@maple/views/ui/meter"
import { middleTruncate } from "@maple/views/ui/middle-truncate"
import { pressable } from "@maple/views/ui/pressable"
import { hstack, vstack } from "@maple/views/ui/stack"
import { statusDot } from "@maple/views/ui/status-dot"
import { typography } from "@maple/views/ui/typography"
import { Array as Arr, Option, Order, String as Str } from "effect"
import { Mount, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { WatchTheme } from "../scene3d"
import { connectedIds, formatRate, health, HEALTH_COLOR, HEALTH_LABEL } from "../three/spatial-layout"
import type { Node3D, Topology3D } from "../three/types"
import { type Biome, biomeOf, biomesFor } from "./biome"
import { type Link, type LinkState, linkState, linksOf, type Placements, prospect, tally } from "./board"
import { daylightAt } from "./daylight"
import {
	CELLS_ATTRIBUTE,
	COMMAND_ATTRIBUTE,
	heldIdOf,
	litClockOf,
	Message,
	type Model,
	MountScene,
	placementsOf,
	STATE_ATTRIBUTE,
	TOPOLOGY_ATTRIBUTE,
	WatchClock,
} from "./update"

// The landscape column: a toolbar, the map with its labels and overlays, and a footer. The parent
// passes the topology and the selection, and draws its own side panel for the selected service.

type H = HtmlBuilder<Message>

export interface ViewInputs {
	readonly topology: Topology3D
	readonly selectedId: string | null
	readonly reducedMotion: boolean
}

/** What every part of the view reads from the topology, worked out once per distinct topology. */
export interface Board {
	readonly topology: Topology3D
	readonly json: string
	readonly links: ReadonlyArray<Link>
	readonly nodesById: ReadonlyMap<string, Node3D>
	readonly biomes: ReadonlyMap<string, Biome>
}

const boards = new WeakMap<Topology3D, Board>()

/** The board for `topology`, worked out once per topology object (the page keeps one per graph). */
export const boardOf = (topology: Topology3D): Board => {
	const known = boards.get(topology)
	if (known !== undefined) return known
	const board: Board = {
		topology,
		json: encodeJson(topology),
		links: linksOf(topology),
		nodesById: new Map(Arr.map(topology.nodes, (node) => [node.id, node] as const)),
		biomes: biomesFor(Arr.map(topology.nodes, (node) => node.namespace)),
	}
	boards.set(topology, board)
	return board
}

export const labelOf = (board: Board, id: string): string => board.nodesById.get(id)?.label ?? id

export const KIND_LABEL = {
	edge: "Entry point",
	service: "Service",
	database: "Database",
	queue: "Queue",
	external: "External",
} as const

const PANEL_CLASS = "rounded-md border bg-surface-float text-popover-foreground shadow-popup backdrop-blur-sm"

/** The card at the foot of the map (the tile in hand, a clicked cart or train). Its width is
 * capped so that, centred, it always clears the camera controls in the bottom left corner. */
const CARD_CLASS = `absolute bottom-3 left-1/2 w-96 max-w-[calc(100%-6.5rem)] -translate-x-1/2 p-3 ${PANEL_CLASS}`

export const healthDot = <M>(h: HtmlBuilder<M>, errorRate: number): Html =>
	statusDot(h, {
		tone: "custom",
		attributes: [h.Style({ "background-color": HEALTH_COLOR[health(errorRate)] })],
	})

const TIME_OF_DAY = { dawn: "Dawn", day: "Day", dusk: "Dusk", night: "Night" } as const

/** What the light button says: the held time of day, or that it follows the viewer's clock. */
const lightLabel = (model: Model): string =>
	model.light === "clock" ? "Light: auto" : `Light: ${Str.toLowerCase(TIME_OF_DAY[model.light])}`

const toolbar = (h: H, model: Model, flowing: boolean): Html => {
	const dealing = model.stack.length > 0
	return hstack(
		h,
		{
			gap: "2",
			align: "center",
			wrap: true,
			className: "shrink-0 border-b px-4 py-2",
			attributes: [h.OnMount(WatchClock())],
		},
		[
			button(
				h,
				{
					size: "sm",
					variant: model.isBuilding && !dealing ? "secondary" : "outline",
					attributes: [
						h.AriaPressed(String(model.isBuilding)),
						h.Disabled(dealing),
						h.OnClick(Message.ClickedRearrange()),
					],
				},
				[icon(h, "GridIcon"), model.isBuilding && !dealing ? "Done rearranging" : "Rearrange"],
			),
			button(h, { size: "sm", variant: "outline", attributes: [h.OnClick(Message.ClickedDeal())] }, [
				icon(h, "LayersIcon"),
				"Deal tiles",
			]),
			button(
				h,
				{ size: "sm", variant: "ghost", attributes: [h.OnClick(Message.ClickedAutoArrange())] },
				[icon(h, "SparkleIcon"), "Auto-arrange"],
			),
			button(
				h,
				{
					size: "sm",
					variant: "ghost",
					className: "ml-auto",
					attributes: [h.AriaPressed(String(!model.isMuted)), h.OnClick(Message.ClickedSound())],
				},
				[model.isMuted ? "Sound off" : "Sound on"],
			),
			button(
				h,
				{
					size: "sm",
					variant: "ghost",
					attributes: [
						h.Title(
							model.light === "clock" && model.clock !== null
								? `Following your local time: ${Str.toLowerCase(TIME_OF_DAY[daylightAt(model.clock).timeOfDay])} now. Click for dawn, day, dusk, night.`
								: "Step through: your local time, dawn, day, dusk, night",
						),
						h.OnClick(Message.ClickedLight()),
					],
				},
				[lightLabel(model)],
			),
			button(
				h,
				{
					size: "sm",
					variant: "ghost",
					attributes: [
						h.AriaPressed(String(flowing)),
						h.OnClick(Message.ClickedTraffic({ isFlowing: flowing })),
					],
				},
				[icon(h, flowing ? "MediaPauseIcon" : "MediaPlayIcon"), flowing ? "Pause" : "Play"],
			),
		],
	)
}

interface CanvasInputs {
	readonly model: Model
	readonly board: Board
	readonly selectedId: string | null
	readonly flowing: boolean
	readonly isDark: boolean
	readonly clock: NonNullable<Model["clock"]>
}

const canvas = (h: H, { model, board, selectedId, flowing, isDark, clock }: CanvasInputs): Html =>
	h.div(
		[h.Key("tiles-canvas"), h.Class("absolute inset-0 overflow-hidden")],
		[
			h.canvas([
				h.Class("block"),
				// Focusable from code only: the map takes the focus while a tile is moved by keyboard.
				h.Attribute("tabindex", "-1"),
				h.Attribute(TOPOLOGY_ATTRIBUTE, board.json),
				h.Attribute(CELLS_ATTRIBUTE, encodeJson(model.cells)),
				h.Attribute(
					STATE_ATTRIBUTE,
					encodeJson({
						selectedId,
						heldId: heldIdOf(model),
						building: model.isBuilding,
						flowing,
						dark: isDark,
						muted: model.isMuted,
						clock: litClockOf(model, clock),
					}),
				),
				h.Attribute(COMMAND_ATTRIBUTE, encodeJson(model.command)),
				h.OnMount(MountScene()),
			]),
		],
	)

/** One name plate per tile on the board. The scene moves them; a plate starts hidden. */
const labels = (h: H, model: Model, board: Board, selectedId: string | null): ReadonlyArray<Html> => {
	const related = connectedIds(board.topology, selectedId)
	return Arr.flatMap(board.topology.nodes, (node) => {
		if (!(node.id in model.cells)) return []
		const isSelected = selectedId === node.id
		const faded = related !== null && !related.has(node.id)
		return [
			pressable(
				h,
				{
					// While rearranging, the canvas takes the pointer; the plate still lifts its tile
					// for the keyboard.
					onClick:
						model.isBuilding && model.stack.length === 0
							? Message.PickedUpTile({ nodeId: node.id })
							: Message.PickedNode({ nodeId: isSelected ? null : node.id }),
					isSelected,
					className: `absolute top-0 left-0 flex max-w-36 items-center gap-1 rounded-sm border px-1.5 py-px font-mono text-4xs whitespace-nowrap ${model.isBuilding ? "pointer-events-none" : "pointer-events-auto"} ${isSelected ? "border-primary bg-popover text-popover-foreground" : "bg-popover text-popover-foreground hover:border-border-strong active:border-border-strong"} ${faded ? "opacity-40" : ""}`,
					attributes: [
						h.Key(node.id),
						h.Attribute("data-tile-label", node.id),
						h.Title(
							`${node.label} · ${formatRate(node.throughput)} · ${formatErrorRate(node.errorRate)} errors`,
						),
						h.Style({ visibility: "hidden" }),
					],
				},
				[healthDot(h, node.errorRate), middleTruncate(h, { text: node.label, tail: 8 })],
			),
		]
	})
}

const scorePanel = (h: H, model: Model, board: Board, cells: Placements): Html => {
	const score = tally(board.links, cells)
	const gain = model.lastGain
	return vstack(
		h,
		{
			gap: "1.5",
			// Narrow, only the headline: the full panel would cover the top of the board.
			className: `absolute top-3 left-3 px-3 py-2 @xl/page:w-64 @xl/page:p-3 ${PANEL_CLASS}`,
			attributes: [h.AriaLabel("Map score")],
		},
		[
			hstack(h, { gap: "2", align: "baseline", justify: "between" }, [
				typography(h, { size: "xs", tone: "muted" }, ["Connections by road"]),
				hstack(h, { gap: "1.5", align: "baseline", as: "span" }, [
					...(gain === null || gain === 0
						? []
						: [
								typography(
									h,
									{
										size: "2xs",
										numeric: true,
										className: gain > 0 ? "text-severity-info" : "text-severity-error",
									},
									[`${gain > 0 ? "+" : "−"}${Math.abs(gain)}`],
								),
							]),
					typography(
						h,
						{ size: "sm", weight: "semibold", numeric: true, className: "whitespace-nowrap" },
						[`${score.roads} / ${score.total}`],
					),
				]),
			]),
			vstack(h, { gap: "1.5", className: "hidden @xl/page:flex" }, [
				meter(h, { value: score.roads, max: Math.max(1, score.total), label: "Connections by road" }),
				typography(h, { size: "2xs", tone: "muted", as: "p" }, [
					score.waiting > 0
						? `${model.stack.length} tiles in the stack · ${score.rails} by rail`
						: `${score.rails} by rail · ${Math.round(score.roadTraffic * 100)}% of traffic goes by road`,
				]),
			]),
		],
	)
}

/** The tile in hand: what it is, how many of its neighbours are down, and what this cell would give it. */
const tileCard = (h: H, model: Model, board: Board, cells: Placements, node: Node3D): Html => {
	const own = Arr.filter(board.links, (link) => link.source === node.id || link.target === node.id)
	const onBoard = Arr.filter(own, (link) =>
		cells.has(link.source === node.id ? link.target : link.source),
	).length
	const here = Option.flatMap(Option.fromNullishOr(model.hover), (cell) =>
		prospect(board.links, cells, node.id, cell),
	)
	const dealing = model.pickedId === null
	return vstack(
		h,
		{
			gap: "2",
			className: CARD_CLASS,
			attributes: [h.AriaLabel("Tile in hand"), h.AriaLive("polite")],
		},
		[
			hstack(h, { gap: "2", align: "center" }, [
				healthDot(h, node.errorRate),
				typography(
					h,
					{ size: "sm", weight: "semibold", truncate: true, className: "min-w-0 flex-1" },
					[node.label],
				),
				badge(h, { variant: "outline", size: "sm" }, [KIND_LABEL[node.kind]]),
			]),
			typography(h, { size: "xs", tone: "muted", as: "p" }, [
				Option.match(here, {
					onNone: () =>
						own.length === 0
							? "Calls nothing on this map. Put it on any pale cell."
							: `${onBoard} of its ${own.length} connections are on the board. Move over a pale cell.`,
					onSome: (outcome) =>
						`Here: ${outcome.roads} by road, ${outcome.rails} by rail${outcome.gain === 0 ? "" : ` · ${outcome.gain > 0 ? "+" : "−"}${Math.abs(outcome.gain)} roads overall`}`,
				}),
			]),
			hstack(h, { gap: "2", align: "center", justify: "between" }, [
				typography(h, { size: "2xs", tone: "muted", className: "whitespace-nowrap" }, [
					dealing ? `${model.stack.length} left in the stack` : "Click a tile to trade places",
				]),
				dealing
					? button(
							h,
							{
								size: "xs",
								variant: "outline",
								attributes: [h.OnClick(Message.ClickedPlaceRest())],
							},
							["Place the rest for me"],
						)
					: button(
							h,
							{
								size: "xs",
								variant: "outline",
								attributes: [h.OnClick(Message.CancelledHold())],
							},
							["Put it back"],
						),
			]),
		],
	)
}

export const STATE_LABEL = { road: "Road", rail: "Rail", waiting: "In stack" } satisfies Record<
	LinkState,
	string
>
const STATE_RANK = { rail: 0, waiting: 1, road: 2 } satisfies Record<LinkState, number>

/** The cart or train that was clicked: what it carries, between which two services, and how the link is doing. */
const linkCard = (h: H, board: Board, cells: Placements, link: Link): Html => {
	const state = linkState(cells, link)
	const source = board.nodesById.get(link.source)
	const produce = biomeOf(board.biomes, source?.namespace ?? "").produce.label
	const stop = (id: string) =>
		button(
			h,
			{
				size: "xs",
				variant: "outline",
				className: "min-w-0",
				attributes: [h.OnClick(Message.PickedNode({ nodeId: id }))],
			},
			[middleTruncate(h, { text: labelOf(board, id), tail: 8 })],
		)
	return vstack(
		h,
		{
			gap: "2",
			className: CARD_CLASS,
			attributes: [h.AriaLabel("Connection"), h.AriaLive("polite")],
		},
		[
			hstack(h, { gap: "2", align: "center" }, [
				healthDot(h, link.errorRate),
				typography(
					h,
					{ size: "sm", weight: "semibold", truncate: true, className: "min-w-0 flex-1" },
					[`${state === "rail" ? "Train" : "Cart"} of ${produce}`],
				),
				badge(h, { variant: state === "road" ? "secondary" : "outline", size: "sm" }, [
					STATE_LABEL[state],
				]),
			]),
			typography(h, { size: "xs", tone: "muted", numeric: true, as: "p" }, [
				`${formatRate(link.callsPerSecond)} · ${formatErrorRate(link.errorRate)} errors · ${HEALTH_LABEL[health(link.errorRate)]}`,
			]),
			hstack(h, { gap: "2", align: "center" }, [
				stop(link.source),
				typography(h, { size: "xs", tone: "muted" }, ["→"]),
				stop(link.target),
				button(
					h,
					{
						size: "xs",
						variant: "ghost",
						className: "ml-auto",
						attributes: [h.OnClick(Message.ClosedLinkCard())],
					},
					["Close"],
				),
			]),
		],
	)
}

const cameraControls = (h: H): Html => {
	const camera = (action: "reset" | "in" | "out") => h.OnClick(Message.ClickedCamera({ action }))
	return h.fieldset(
		[
			h.Class(`absolute bottom-3 left-3 flex flex-col gap-0.5 p-0.5 ${PANEL_CLASS}`),
			h.AriaLabel("Camera controls"),
		],
		[
			iconButton(h, { size: "icon-xs", label: "Zoom in", attributes: [camera("in")] }, ["+"]),
			iconButton(h, { size: "icon-xs", label: "Zoom out", attributes: [camera("out")] }, ["−"]),
			iconButton(h, { size: "icon-xs", label: "Reset camera", attributes: [camera("reset")] }, [
				icon(h, "ArrowRotateAnticlockwiseIcon"),
			]),
		],
	)
}

const sceneFailed = (h: H): Html =>
	vstack(
		h,
		{ gap: "2", align: "center", justify: "center", className: "absolute inset-0 p-8 text-center" },
		[
			typography(h, { size: "sm", as: "p" }, ["3D rendering is unavailable."]),
			typography(h, { size: "sm", tone: "muted", as: "p" }, [
				"The 2D view shows the same services and connections. Reload to try again.",
			]),
		],
	)

const viewport = (h: H, model: Model, board: Board, inputs: ViewInputs, flowing: boolean): Html => {
	const cells = placementsOf(model)
	const heldId = heldIdOf(model)
	const held = heldId === null ? undefined : board.nodesById.get(heldId)
	const poked = Option.getOrUndefined(Arr.findFirst(board.links, (link) => link.id === model.pokedLinkId))
	return h.section(
		[
			h.Class("relative min-h-0 flex-1 overflow-hidden bg-background"),
			h.AriaLabel("Service map landscape"),
			h.DataAttribute("tiles-root", ""),
			h.OnMount(Mount.mapMessage(WatchTheme(), ({ isDark }) => Message.ResolvedTheme({ isDark }))),
		],
		[
			model.isFailed
				? sceneFailed(h)
				: model.isDark === null || model.clock === null
					? h.div([], [])
					: canvas(h, {
							model,
							board,
							selectedId: inputs.selectedId,
							flowing,
							isDark: model.isDark,
							clock: model.clock,
						}),
			layer(h, { clip: true, attributes: [h.AriaLabel("Services on the map")] }, [
				...labels(h, model, board, inputs.selectedId),
			]),
			scorePanel(h, model, board, cells),
			cameraControls(h),
			...(held === undefined ? [] : [tileCard(h, model, board, cells, held)]),
			...(held === undefined && poked !== undefined ? [linkCard(h, board, cells, poked)] : []),
		],
	)
}

// One line whatever the hint says: a footer that wraps when a tile is lifted would shrink the
// map under the pointer.
const footer = (h: H, model: Model): Html =>
	hstack(
		h,
		{
			gap: "3",
			align: "center",
			justify: "between",
			className: "shrink-0 border-t px-4 py-2 text-3xs text-muted-foreground",
		},
		[
			typography(h, { truncate: true, className: "min-w-0" }, [
				heldIdOf(model) !== null
					? model.pickedId === null
						? "Click a pale cell to put the tile down · or arrow keys, then Enter"
						: "Click a pale cell or another tile · or arrow keys, then Enter · Esc puts it back"
					: model.isBuilding
						? `Click a tile to lift it, or press Enter on its name · drag to pan · right-drag to turn`
						: `Click anything · drag to pan · right-drag to turn`,
			]),
			hstack(h, { gap: "3", as: "span", className: "shrink-0 whitespace-nowrap" }, [
				typography(h, { className: "hidden @5xl/page:inline" }, [
					"Touching tiles share a road · the rest go by rail",
				]),
				...Arr.map(["healthy", "elevated", "degraded"] as const, (status) =>
					hstack(h, { gap: "1", as: "span" }, [
						statusDot(h, {
							tone: "custom",
							attributes: [h.Style({ "background-color": HEALTH_COLOR[status] })],
						}),
						HEALTH_LABEL[status],
					]),
				),
			]),
		],
	)

export interface LinkEntry {
	readonly link: Link
	readonly state: LinkState
}

/** Railways first (the ones a better layout would fix), then by traffic. */
export const sortedLinks = (cells: Placements, own: ReadonlyArray<Link>): ReadonlyArray<LinkEntry> =>
	Arr.sort(
		Arr.map(own, (link): LinkEntry => ({ link, state: linkState(cells, link) })),
		Order.combine(
			Order.mapInput(Order.Number, (entry: LinkEntry) => STATE_RANK[entry.state]),
			Order.flip(Order.mapInput(Order.Number, (entry: LinkEntry) => entry.link.callsPerSecond)),
		),
	)

/** The landscape column over the parent's topology, for the parent to place beside its own panels. */
export const mapColumn = (model: Model, inputs: ViewInputs, h: H): Html => {
	const board = boardOf(inputs.topology)
	const flowing = model.traffic ?? !inputs.reducedMotion
	return vstack(
		h,
		{ className: "h-full min-h-0", attributes: [h.DataAttribute("service-map-renderer", "tiles")] },
		[toolbar(h, model, flowing), viewport(h, model, board, inputs, flowing), footer(h, model)],
	)
}

/** `mapColumn` as a submodel view, for a parent with its own Message. */
export const view = Submodel.defineView<Model, Message, ViewInputs>(mapColumn)
