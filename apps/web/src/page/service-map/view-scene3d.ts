import { liveTopology } from "../../components/service-map/three/live-topology"
import { mapPalette, paperBackground } from "../../components/service-map/three/palette"
import {
	connectedIds,
	type District,
	formatLatency,
	formatRate,
	HEALTH_COLOR,
	HEALTH_LABEL,
} from "../../components/service-map/three/spatial-layout"
import type { Edge3D, Topology3D } from "../../components/service-map/three/types"
import { Option } from "effect"
import { Mount } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type * as ServiceMap from "../../service-map/map/service-map"
import { button } from "../../ui/button"
import { icon } from "../../ui/icon"
import { iconButton } from "../../ui/icon-button"
import { middleTruncate } from "../../ui/middle-truncate"
import { statusDot } from "../../ui/status-dot"
import * as ToggleGroup from "../../ui/toggle-group"
import { machineBadge } from "./badge"
import {
	COMMAND_ATTRIBUTE,
	Message,
	type Model,
	MountScene,
	STATE_ATTRIBUTE,
	TOPOLOGY_ATTRIBUTE,
	WatchTheme,
} from "./scene3d"
import { type LinkLabel, linkLabels, spatialLayoutOf } from "./scene-layout"

// The 3D viewport: the perspective bar, the
// paper section with the canvas wrappers, the timber sign labels, the HUD, legend and camera
// controls, and the footer. The scene Mount positions the labels each frame.

const VIEW_COPY = {
	atlas: {
		title: "Atlas",
		description: "Infrastructure, organized by namespace.",
		encoding: "Machine height · request volume",
	},
	cascade: {
		title: "Cascade",
		description: "Layers follow the longest dependency path.",
		encoding: "Layer height · dependency depth",
	},
} as const

// Labels are timber signs. Styling lives in classes because the camera rig
// rewrites inline style every frame, keeping only position and colour.
const NAIL =
	"before:absolute before:top-1/2 before:size-[2px] before:-translate-y-1/2 before:rounded-full before:bg-current after:absolute after:top-1/2 after:size-[2px] after:-translate-y-1/2 after:rounded-full after:bg-current"
const SIGN_CLASS = "rounded-[3px] px-1.5 font-medium"
const TAG_CLASS =
	"rounded-l-[7px] rounded-r-[2px] border-current/50 pr-1 pl-2.5 before:absolute before:top-1/2 before:left-[3px] before:size-[3px] before:-translate-y-1/2 before:rounded-full before:border before:border-current/70 after:absolute after:bottom-full after:left-[4px] after:h-1.5 after:w-px after:bg-current/50"
const PLANK_CLASS = `rounded-[2px] px-2.5 py-px font-semibold before:left-[4px] after:right-[4px] ${NAIL}`

const PANEL_CLASS = "rounded-[3px] border border-(--map-sign-ink)/35 bg-(--map-sign) text-(--map-sign-ink)"

const LABEL = "data-scene-label"

function edgeLatency(edge: Edge3D) {
	return edge.p95LatencyMs !== undefined
		? `${formatLatency(edge.p95LatencyMs)} p95`
		: `${formatLatency(edge.avgLatencyMs)} avg · ${formatLatency(edge.maxLatencyMs)} max`
}

export type Scene3dOptions<M> = Readonly<{
	model: Model
	map: ServiceMap.Model
	toMessage: (message: Message) => M
}>

/** `ServiceMap3DViewport`'s props: a fixed topology, as the 3D lab passes it with `sample`. */
export type ViewportOptions<M> = Readonly<{
	model: Model
	topology: Topology3D
	selectedId: string | null
	reducedMotion: boolean
	sample?: boolean
	toMessage: (message: Message) => M
}>

type Palette = ReturnType<typeof mapPalette>

/** `topology` as `LiveServiceMap3D` builds it from the effective graph and its dimming. */
export const topologyOf = (map: ServiceMap.Model): Topology3D =>
	liveTopology(
		map.graph.nodes,
		map.graph.edges,
		map.graph.declutter.dimmedNodeIds,
		map.graph.declutter.dimmedEdgeIds,
	)

const perspectiveBar = <M>(
	h: HtmlBuilder<M>,
	{ model, reducedMotion, toMessage }: ViewportOptions<M>,
): Html => {
	const flowing = model.traffic ?? !reducedMotion
	return h.div(
		[h.Class("flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2")],
		[
			ToggleGroup.view(h, {
				model: model.perspectiveGroup,
				toParentMessage: (message) => toMessage(Message.GotPerspectiveMessage({ message })),
				variant: "outline",
				size: "xs",
				items: [
					{
						value: "atlas",
						label: "Atlas",
						children: [icon(h, "CubeIcon", { size: 14 }), "Atlas"],
					},
					{
						value: "cascade",
						label: "Cascade",
						children: [icon(h, "LayersIcon", { size: 14 }), "Cascade"],
					},
				],
			}),
			h.span(
				[h.Class("ml-3 hidden text-2xs text-muted-foreground sm:block")],
				[VIEW_COPY[model.perspective].encoding],
			),
			// Reduced motion starts the traffic paused; the button still turns it on.
			button(
				h,
				{
					size: "sm",
					variant: "ghost",
					className: "ml-auto text-xs",
					attributes: [
						h.AriaPressed(String(flowing)),
						h.OnClick(toMessage(Message.ClickedTraffic({ isFlowing: flowing }))),
						...(reducedMotion && !flowing
							? [h.Title("Paused for your reduced-motion setting")]
							: []),
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

/** The labels' inline style before the rig first places them. */
const signStyle = (palette: Palette): Record<string, string> => ({
	visibility: "hidden",
	"background-color": palette.sign,
	color: palette.signInk,
})

/** A node sign's style also carries its opacity, between visibility and colours. */
const nodeSignStyle = (palette: Palette, opacity: number): Record<string, string> => ({
	visibility: "hidden",
	opacity: String(opacity),
	"background-color": palette.sign,
	color: palette.signInk,
})

const nodeLabels = <M>(
	h: HtmlBuilder<M>,
	topology: Topology3D,
	selectedId: string | null,
	palette: Palette,
	toMessage: (message: Message) => M,
): ReadonlyArray<Html> => {
	const related = connectedIds(topology, selectedId)
	return topology.nodes.map((node) => {
		const badge = machineBadge(node)
		const isSelected = selectedId === node.id
		return h.button(
			[
				h.Key(node.id),
				h.Type("button"),
				h.Attribute(LABEL, node.id),
				h.Title(badge ? `${node.label} · ${badge.label}` : node.label),
				h.Class(
					`pointer-events-auto absolute top-0 left-0 flex max-w-40 border font-mono text-4xs leading-normal whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-ring ${SIGN_CLASS} ${isSelected ? "border-current" : "border-current/60 hover:border-current"}`,
				),
				h.Style(nodeSignStyle(palette, node.dimmed || (related && !related.has(node.id)) ? 0.4 : 1)),
				h.OnClick(toMessage(Message.PickedNode({ nodeId: isSelected ? null : node.id }))),
				h.AriaLabel(`Select ${node.label}${badge ? `, ${badge.label}` : ""}`),
				h.AriaPressed(String(isSelected)),
			],
			[middleTruncate(h, { text: node.label, tail: 10 })],
		)
	})
}

const linkTags = <M>(
	h: HtmlBuilder<M>,
	topology: Topology3D,
	links: ReadonlyArray<LinkLabel>,
	selectedId: string | null,
	palette: Palette,
	toMessage: (message: Message) => M,
): ReadonlyArray<Html> => {
	const labelOf = (id: string) => topology.nodes.find((node) => node.id === id)?.label
	return links
		.filter((link) => !link.edge.relation)
		.filter((link) =>
			selectedId ? link.edge.source === selectedId || link.edge.target === selectedId : link.prominent,
		)
		.map((link) => {
			const rate = formatRate(link.edge.callsPerSecond, link.edge.hasSampling)
			return h.button(
				[
					h.Key(link.id),
					h.Type("button"),
					h.Attribute(LABEL, link.id),
					h.Class(
						`pointer-events-auto absolute top-0 left-0 flex cursor-pointer items-center border font-mono text-4xs leading-normal tabular-nums hover:border-current focus-visible:outline-2 focus-visible:outline-ring ${TAG_CLASS}`,
					),
					h.Style(signStyle(palette)),
					h.Title(
						`${labelOf(link.edge.source)} → ${labelOf(link.edge.target)} · ${rate} calls · ${edgeLatency(link.edge)}`,
					),
					h.AriaLabel(`Inspect connection to ${labelOf(link.edge.target)}, ${rate}`),
					h.OnClick(toMessage(Message.PickedNode({ nodeId: link.edge.target }))),
				],
				[rate],
			)
		})
}

const districtPlanks = <M>(
	h: HtmlBuilder<M>,
	districts: ReadonlyArray<District>,
	perspective: string,
	palette: Palette,
): ReadonlyArray<Html> =>
	districts.map((district) =>
		h.span(
			[
				h.Key(`${perspective}:${district.id}`),
				h.Attribute(LABEL, `district:${district.id}`),
				h.Class(`absolute top-0 left-0 font-mono text-4xs uppercase tracking-widest ${PLANK_CLASS}`),
				h.Style({ visibility: "hidden", "background-color": palette.trunk, color: palette.tape }),
			],
			[district.label],
		),
	)

/** R3F's `<Canvas style={{ position: "absolute", inset: 0 }}>`: two wrapper divs and the canvas. */
const canvas = <M>(
	h: HtmlBuilder<M>,
	input: {
		topology: Topology3D
		selectedId: string | null
		model: Model
		flowing: boolean
		isDark: boolean
	},
	toMessage: (message: Message) => M,
): Html =>
	h.div(
		[
			h.Key("scene-canvas"),
			h.Style({
				position: "absolute",
				width: "100%",
				height: "100%",
				overflow: "hidden",
				"pointer-events": "auto",
				inset: "0px",
			}),
		],
		[
			h.div(
				[h.Style({ width: "100%", height: "100%" })],
				[
					h.canvas([
						h.Style({ display: "block" }),
						h.Attribute(TOPOLOGY_ATTRIBUTE, JSON.stringify(input.topology)),
						h.Attribute(
							STATE_ATTRIBUTE,
							JSON.stringify({
								selectedId: input.selectedId,
								view: input.model.perspective,
								flowing: input.flowing,
								dark: input.isDark,
							}),
						),
						h.Attribute(COMMAND_ATTRIBUTE, JSON.stringify(input.model.command)),
						h.OnMount(Mount.mapMessage(MountScene(), toMessage)),
					]),
				],
			),
		],
	)

const sceneFailed = <M>(h: HtmlBuilder<M>): Html =>
	h.div(
		[h.Class("absolute inset-0 grid place-content-center gap-2 p-8 text-center text-sm")],
		[
			h.p([], ["3D rendering is unavailable."]),
			h.p(
				[h.Class("text-muted-foreground")],
				["Use the service list to inspect connections, or reload to retry."],
			),
		],
	)

const overlays = <M>(
	h: HtmlBuilder<M>,
	model: Model,
	toMessage: (message: Message) => M,
): ReadonlyArray<Html> => {
	const copy = VIEW_COPY[model.perspective]
	const camera = (action: "reset" | "in" | "out") => h.OnClick(toMessage(Message.ClickedCamera({ action })))
	return [
		h.div(
			[
				h.Attribute(LABEL, "overlay:hud"),
				h.Class(`pointer-events-none absolute top-4 left-4 px-3 py-2 ${PANEL_CLASS}`),
			],
			[
				h.h2([h.Class("font-display text-base font-medium")], [copy.title]),
				h.p([h.Class(`mt-1 text-2xs opacity-75`)], [copy.description]),
			],
		),
		h.div(
			[
				h.Attribute(LABEL, "overlay:legend"),
				h.Class(
					`pointer-events-none absolute right-4 bottom-4 flex flex-wrap gap-3 px-3 py-2 text-3xs ${PANEL_CLASS}`,
				),
			],
			(["healthy", "elevated", "degraded"] as const).map((status) =>
				h.span(
					[h.Class("flex items-center gap-1.5")],
					[
						statusDot(h, {
							tone: "custom",
							attributes: [h.Style({ "background-color": HEALTH_COLOR[status] })],
						}),
						HEALTH_LABEL[status],
					],
				),
			),
		),
		h.fieldset(
			[
				h.Attribute(LABEL, "overlay:controls"),
				// The 2D canvases' control stack: bottom left, zoom in, zoom out, then fit.
				h.Class(`absolute bottom-4 left-4 flex flex-col gap-1 p-1 ${PANEL_CLASS}`),
				h.AriaLabel("Camera controls"),
			],
			[
				iconButton(h, { size: "icon-xs", label: "Zoom in", attributes: [camera("in")] }, ["+"]),
				iconButton(h, { size: "icon-xs", label: "Zoom out", attributes: [camera("out")] }, ["−"]),
				iconButton(h, { size: "icon-xs", label: "Reset camera", attributes: [camera("reset")] }, [
					icon(h, "ArrowRotateAnticlockwiseIcon"),
				]),
			],
		),
	]
}

/** The 3D view: `render3D` of the map. Labels and overlays are DOM; the scene draws behind them. */
export const scene3dView = <M>(h: HtmlBuilder<M>, { model, map, toMessage }: Scene3dOptions<M>): Html =>
	viewportView(h, {
		model,
		topology: topologyOf(map),
		selectedId: Option.getOrNull(map.selectedId),
		reducedMotion: map.reducedMotion,
		toMessage,
	})

/** `ServiceMap3DViewport` over any topology. */
export const viewportView = <M>(h: HtmlBuilder<M>, options: ViewportOptions<M>): Html => {
	const { model, topology, selectedId, toMessage } = options
	const isDark = model.isDark ?? true
	const palette = mapPalette(isDark)
	const flowing = model.traffic ?? !options.reducedMotion
	const layout = spatialLayoutOf(topology, model.perspective)
	const related = connectedIds(topology, selectedId)
	const background = paperBackground(palette)
	const scene = model.isFailed
		? sceneFailed(h)
		: model.isDark === null
			? h.div([], [])
			: canvas(h, { topology, selectedId, model, flowing, isDark }, toMessage)
	return h.div(
		[
			h.Class("flex h-full min-h-0 flex-col"),
			h.DataAttribute("service-map-renderer", "3d"),
			h.OnMount(Mount.mapMessage(WatchTheme(), toMessage)),
		],
		[
			perspectiveBar(h, options),
			h.section(
				[
					h.Class("relative min-h-0 flex-1 overflow-hidden"),
					h.AriaLabel(`${VIEW_COPY[model.perspective].title} 3D service map`),
					h.DataAttribute("scene-root", ""),
					h.Style({
						"background-color": background.backgroundColor,
						"background-image": background.backgroundImage,
						"background-size": background.backgroundSize,
						"--map-sign": palette.sign,
						"--map-sign-ink": palette.signInk,
					}),
				],
				[
					scene,
					// The island fades into the paper instead of stopping at the canvas edge.
					h.div(
						[
							h.Class("pointer-events-none absolute inset-0"),
							h.AriaHidden(true),
							h.Style({
								"background-image": `radial-gradient(ellipse at center, transparent 58%, ${palette.paper} 100%)`,
							}),
						],
						[],
					),
					h.div(
						[
							h.Class("pointer-events-none absolute inset-0 overflow-hidden"),
							h.AriaLabel("Map nodes"),
						],
						[
							...nodeLabels(h, topology, selectedId, palette, toMessage),
							...linkTags(
								h,
								topology,
								linkLabels(topology, layout),
								selectedId,
								palette,
								toMessage,
							),
							...districtPlanks(h, layout.districts, model.perspective, palette),
						],
					),
					...overlays(h, model, toMessage),
				],
			),
			h.div(
				[
					h.Class(
						"flex shrink-0 flex-wrap items-center justify-between gap-2 border-t px-4 py-2 text-3xs text-muted-foreground",
					),
				],
				[
					h.span([], ["Drag to pan · scroll to zoom"]),
					h.span(
						[],
						[
							selectedId
								? `${related?.size ?? 0} connected nodes · click the canvas to clear`
								: options.sample === true
									? "Narrow belts · calls / Wide belts · queues · sample traffic"
									: "Rates from selected time range · ~ sampled estimate",
						],
					),
				],
			),
		],
	)
}
