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
import { Mount } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { pageBody, pageContent } from "../../page/kit/dashboard-page"
import { WatchTheme } from "../../page/service-map/scene3d"
import {
	connectedIds,
	formatLatency,
	formatRate,
	health,
	HEALTH_COLOR,
	HEALTH_LABEL,
} from "../../page/service-map/three/spatial-layout"
import type { Node3D } from "../../page/service-map/three/types"
import { biomeOf, biomesFor } from "./biome"
import { type Link, type LinkState, linkState, type Placements, prospect, tally } from "./board"
import { daylightAt } from "./daylight"
import {
	CELLS_ATTRIBUTE,
	COMMAND_ATTRIBUTE,
	heldIdOf,
	links,
	litClockOf,
	Message,
	type Model,
	MountScene,
	placementsOf,
	STATE_ATTRIBUTE,
	topology,
	TOPOLOGY_ATTRIBUTE,
	WatchClock,
} from "./update"

// The page: a toolbar, the landscape with its labels and overlays, and a side rail of connections.

type H = HtmlBuilder<Message>

const TOPOLOGY_JSON = encodeJson(topology)
const nodesById = new Map(Arr.map(topology.nodes, (node) => [node.id, node] as const))
const labelOf = (id: string): string => nodesById.get(id)?.label ?? id
const biomes = biomesFor(Arr.map(topology.nodes, (node) => node.namespace))

const KIND_LABEL = {
	edge: "Entry point",
	service: "Service",
	database: "Database",
	queue: "Queue",
	external: "External",
} as const

const KIND_BUILDING = {
	edge: "a lighthouse by a pond",
	service: "a village",
	database: "an observatory",
	queue: "a windmill",
	external: "a keep",
} as const

const PANEL_CLASS = "rounded-md border bg-surface-float text-popover-foreground shadow-popup backdrop-blur-sm"

/** The card at the foot of the map (the tile in hand, a clicked cart or train). Its width is
 * capped so that, centred, it always clears the camera controls in the bottom left corner. */
const CARD_CLASS = `absolute bottom-3 left-1/2 w-96 max-w-[calc(100%-6.5rem)] -translate-x-1/2 p-3 ${PANEL_CLASS}`

const healthDot = (h: H, errorRate: number): Html =>
	statusDot(h, {
		tone: "custom",
		attributes: [h.Style({ "background-color": HEALTH_COLOR[health(errorRate)] })],
	})

const TIME_OF_DAY = { dawn: "Dawn", day: "Day", dusk: "Dusk", night: "Night" } as const

/** What the light button says: the held time of day, or what the viewer's clock makes it now. */
const lightLabel = (model: Model): string =>
	model.light === "clock"
		? `Light: local time (${Str.toLowerCase(TIME_OF_DAY[daylightAt(model.clock).timeOfDay])})`
		: `Light: ${Str.toLowerCase(TIME_OF_DAY[model.light])}`

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
				"Deal the tiles",
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
						h.Title("Step through: your local time, dawn, day, dusk, night"),
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
				[
					icon(h, flowing ? "MediaPauseIcon" : "MediaPlayIcon"),
					flowing ? "Pause traffic" : "Play traffic",
				],
			),
		],
	)
}

const canvas = (h: H, model: Model, flowing: boolean, isDark: boolean): Html =>
	h.div(
		[h.Key("tiles-canvas"), h.Class("absolute inset-0 overflow-hidden")],
		[
			h.canvas([
				h.Class("block"),
				h.Attribute(TOPOLOGY_ATTRIBUTE, TOPOLOGY_JSON),
				h.Attribute(CELLS_ATTRIBUTE, encodeJson(model.cells)),
				h.Attribute(
					STATE_ATTRIBUTE,
					encodeJson({
						selectedId: model.selectedId,
						heldId: heldIdOf(model),
						building: model.isBuilding,
						flowing,
						dark: isDark,
						muted: model.isMuted,
						clock: litClockOf(model),
					}),
				),
				h.Attribute(COMMAND_ATTRIBUTE, encodeJson(model.command)),
				h.OnMount(MountScene()),
			]),
		],
	)

/** One name plate per tile on the board. The scene moves them; a plate starts hidden. */
const labels = (h: H, model: Model): ReadonlyArray<Html> => {
	const related = connectedIds(topology, model.selectedId)
	return Arr.flatMap(topology.nodes, (node) => {
		if (!(node.id in model.cells)) return []
		const isSelected = model.selectedId === node.id
		const faded = related !== null && !related.has(node.id)
		return [
			pressable(
				h,
				{
					onClick: Message.PickedNode({ nodeId: isSelected ? null : node.id }),
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

const scorePanel = (h: H, model: Model, cells: Placements): Html => {
	const score = tally(links, cells)
	const gain = model.lastGain
	return vstack(
		h,
		{
			gap: "1.5",
			className: `absolute top-3 left-3 w-64 p-3 ${PANEL_CLASS}`,
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
			meter(h, { value: score.roads, max: Math.max(1, score.total), label: "Connections by road" }),
			typography(h, { size: "2xs", tone: "muted", as: "p" }, [
				score.waiting > 0
					? `${model.stack.length} tiles in the stack · ${score.rails} by rail`
					: `${score.rails} by rail · ${Math.round(score.roadTraffic * 100)}% of traffic goes by road`,
			]),
		],
	)
}

/** The tile in hand: what it is, how many of its neighbours are down, and what this cell would give it. */
const tileCard = (h: H, model: Model, cells: Placements, node: Node3D): Html => {
	const own = Arr.filter(links, (link) => link.source === node.id || link.target === node.id)
	const onBoard = Arr.filter(own, (link) =>
		cells.has(link.source === node.id ? link.target : link.source),
	).length
	const here = Option.flatMap(Option.fromNullishOr(model.hover), (cell) =>
		prospect(links, cells, node.id, cell),
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

/** The cart or train that was clicked: what it carries, between which two services, and how the link is doing. */
const linkCard = (h: H, cells: Placements, link: Link): Html => {
	const state = linkState(cells, link)
	const source = nodesById.get(link.source)
	const produce = biomeOf(biomes, source?.namespace ?? "").produce.label
	const stop = (id: string) =>
		button(
			h,
			{
				size: "xs",
				variant: "outline",
				className: "min-w-0",
				attributes: [h.OnClick(Message.PickedNode({ nodeId: id }))],
			},
			[middleTruncate(h, { text: labelOf(id), tail: 8 })],
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
				"The connections are listed beside the map. Reload to try again.",
			]),
		],
	)

const viewport = (h: H, model: Model, flowing: boolean): Html => {
	const cells = placementsOf(model)
	const heldId = heldIdOf(model)
	const held = heldId === null ? undefined : nodesById.get(heldId)
	const poked = Option.getOrUndefined(Arr.findFirst(links, (link) => link.id === model.pokedLinkId))
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
				: model.isDark === null
					? h.div([], [])
					: canvas(h, model, flowing, model.isDark),
			layer(h, { clip: true, attributes: [h.AriaLabel("Services on the map")] }, [...labels(h, model)]),
			scorePanel(h, model, cells),
			cameraControls(h),
			...(held === undefined ? [] : [tileCard(h, model, cells, held)]),
			...(held === undefined && poked !== undefined ? [linkCard(h, cells, poked)] : []),
		],
	)
}

const footer = (h: H, model: Model): Html =>
	hstack(
		h,
		{
			gap: "2",
			align: "center",
			justify: "between",
			wrap: true,
			className: "shrink-0 border-t px-4 py-2 text-3xs text-muted-foreground",
		},
		[
			h.span(
				[],
				[
					heldIdOf(model) !== null
						? model.pickedId === null
							? "Click a pale cell to put the tile down"
							: "Click a pale cell or another tile · Esc puts it back"
						: model.isBuilding
							? "Click a tile to lift it · drag to pan · right-drag to turn"
							: "Click anything · drag to pan · right-drag to turn",
				],
			),
			hstack(h, { gap: "3", wrap: true, as: "span" }, [
				h.span([], ["Touching tiles share a road · the rest go by rail"]),
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

const STATE_LABEL = { road: "Road", rail: "Rail", waiting: "In stack" } satisfies Record<LinkState, string>
const STATE_RANK = { rail: 0, waiting: 1, road: 2 } satisfies Record<LinkState, number>

const ROW_CLASS =
	"flex w-full flex-col gap-1 px-4 py-2 text-left hover:bg-surface-strong active:bg-surface-strong focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2"

const linkRow = (h: H, link: Link, state: LinkState, towards: string): Html =>
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
					`${labelOf(link.source)} → ${labelOf(link.target)}`,
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

interface LinkEntry {
	readonly link: Link
	readonly state: LinkState
}

/** Railways first (the ones a better layout would fix), then by traffic. */
const sortedLinks = (cells: Placements, own: ReadonlyArray<Link>): ReadonlyArray<LinkEntry> =>
	Arr.sort(
		Arr.map(own, (link): LinkEntry => ({ link, state: linkState(cells, link) })),
		Order.combine(
			Order.mapInput(Order.Number, (entry: LinkEntry) => STATE_RANK[entry.state]),
			Order.flip(Order.mapInput(Order.Number, (entry: LinkEntry) => entry.link.callsPerSecond)),
		),
	)

const RAIL_CLASS =
	"flex max-h-120 min-h-80 flex-col overflow-y-auto border-t bg-background xl:max-h-none xl:min-h-0 xl:border-t-0 xl:border-l"

const inspector = (h: H, cells: Placements, node: Node3D): Html => {
	const own = sortedLinks(
		cells,
		Arr.filter(links, (link) => link.source === node.id || link.target === node.id),
	)
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
					`${KIND_LABEL[node.kind]} in ${node.namespace}: ${KIND_BUILDING[node.kind]} in ${Str.toLowerCase(biomeOf(biomes, node.namespace).label)} country, sending ${biomeOf(biomes, node.namespace).produce.label}`,
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
				linkRow(h, link, state, link.source === node.id ? link.target : link.source),
			),
		],
	)
}

/** Which country each namespace is, and what its tiles send down the road. */
const biomeLegend = (h: H): Html =>
	vstack(h, { gap: "1.5", className: "border-b p-4", attributes: [h.AriaLabel("Namespaces")] }, [
		typography(h, { size: "xs", weight: "semibold" }, ["Namespaces"]),
		...Arr.map([...biomes], ([namespace, biome]) =>
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

const connections = (h: H, cells: Placements): Html => {
	const all = sortedLinks(cells, links)
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
			biomeLegend(h),
			...Arr.map(all, ({ link, state }) => linkRow(h, link, state, link.source)),
		],
	)
}

export const view = (model: Model, h: H): Html => {
	const flowing = model.traffic ?? !model.reducedMotion
	const cells = placementsOf(model)
	const selected = model.selectedId === null ? undefined : nodesById.get(model.selectedId)
	return pageBody(h, [
		pageContent(h, [
			h.div(
				[
					h.Class(
						"grid h-full min-h-0 grid-cols-1 overflow-y-auto xl:grid-cols-[minmax(0,1fr)_288px] xl:overflow-hidden",
					),
				],
				[
					vstack(h, { className: "h-[640px] min-h-0 xl:h-auto" }, [
						toolbar(h, model, flowing),
						viewport(h, model, flowing),
						footer(h, model),
					]),
					selected === undefined ? connections(h, cells) : inspector(h, cells, selected),
				],
			),
		]),
	])
}
