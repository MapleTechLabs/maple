import type { Html, HtmlBuilder } from "foldkit/html"
import { icon } from "../../ui/icon"
import { pressable } from "../../ui/pressable"
import { Message, type Model } from "../xyflow/canvas"
import type { Rect } from "../xyflow/geometry"

// `ServiceMapControls`, `ServiceMapMiniMap` and `ServiceMapBackground` (packages/ui `service-map/`).

const controlButton = <M>(
	h: HtmlBuilder<M>,
	kind: string,
	label: string,
	disabled: boolean,
	onClick: M,
	icon: Html,
) =>
	pressable(
		h,
		{
			onClick,
			label,
			isDisabled: disabled,
			className: `react-flow__controls-button react-flow__controls-${kind}`,
			attributes: [h.Title(label)],
		},
		[icon],
	)

export const serviceMapControls = <M>(
	h: HtmlBuilder<M>,
	model: Model,
	toMessage: (message: Message) => M,
): Html =>
	h.div(
		[
			h.Class("react-flow__panel react-flow__controls vertical bottom left"),
			h.DataAttribute("testid", "rf__controls"),
			h.AriaLabel("Control panel"),
		],
		[
			controlButton(
				h,
				"zoomin",
				"Zoom in",
				model.viewport.zoom >= model.maxZoom,
				toMessage(Message.ClickedZoomIn()),
				icon(h, "PlusIcon", { className: "size-3" }),
			),
			controlButton(
				h,
				"zoomout",
				"Zoom out",
				model.viewport.zoom <= model.minZoom,
				toMessage(Message.ClickedZoomOut()),
				icon(h, "MinusIcon", { className: "size-3" }),
			),
			controlButton(
				h,
				"fitview",
				"Fit view",
				false,
				toMessage(Message.ClickedFitView()),
				icon(h, "MaximizeIcon", { className: "size-3" }),
			),
		],
	)

const GAP = 16
const DOT_SIZE = 1
const PATTERN_ID = "service-map-dot-pattern"

/** React Flow's dotted background, tracking the camera. */
export const serviceMapBackground = <M>(h: HtmlBuilder<M>, model: Model): Html => {
	const { x, y, zoom } = model.viewport
	const scaledGap = GAP * zoom || 1
	const radius = (DOT_SIZE * zoom) / 2
	const offset = 1 + scaledGap / 2
	return h.svg(
		[
			h.Class("react-flow__background"),
			h.DataAttribute("testid", "rf__background"),
			h.Style({ position: "absolute", width: "100%", height: "100%", inset: "0px" }),
			h.AriaHidden(true),
		],
		[
			h.pattern(
				[
					h.Id(PATTERN_ID),
					h.Attribute("patternUnits", "userSpaceOnUse"),
					h.Attribute("x", String(x % scaledGap)),
					h.Attribute("y", String(y % scaledGap)),
					h.Attribute("width", String(scaledGap)),
					h.Attribute("height", String(scaledGap)),
					h.Attribute("patternTransform", `translate(-${offset},-${offset})`),
				],
				[
					h.circle([
						h.Class("react-flow__background-pattern dots"),
						h.Attribute("cx", String(radius)),
						h.Attribute("cy", String(radius)),
						h.Attribute("r", String(radius)),
					]),
				],
			),
			h.rect([
				h.Attribute("x", "0"),
				h.Attribute("y", "0"),
				h.Attribute("width", "100%"),
				h.Attribute("height", "100%"),
				h.Attribute("fill", `url(#${PATTERN_ID})`),
			]),
		],
	)
}

const MINIMAP_WIDTH = 200
const MINIMAP_HEIGHT = 150
const MINIMAP_OFFSET = 5
const MINIMAP_MASK = "oklch(0.15 0 0 / 0.8)"

export interface MiniMapNode extends Rect {
	readonly fill: string
}

/** The minimap's node rects; memoized by the caller so camera moves only touch the viewBox and mask. */
export const miniMapRects = <M>(h: HtmlBuilder<M>, nodes: ReadonlyArray<MiniMapNode>): Html =>
	h.g(
		[],
		nodes.map((node) =>
			h.rect([
				h.Attribute("x", String(node.x)),
				h.Attribute("y", String(node.y)),
				h.Attribute("width", String(node.width)),
				h.Attribute("height", String(node.height)),
				h.Attribute("rx", "5"),
				h.Attribute("ry", "5"),
				h.Attribute("fill", node.fill),
				h.Attribute("shape-rendering", "crispEdges"),
			]),
		),
	)

/** Read-only overview; `nodes` are the measured, non-group nodes in render order. */
export const serviceMapMiniMap = <M>(
	h: HtmlBuilder<M>,
	model: Model,
	nodes: ReadonlyArray<MiniMapNode>,
	rects: Html,
): Html => {
	const { viewport, pane } = model
	const zoom = Math.max(viewport.zoom, 0.001)
	const view = {
		x: -viewport.x / zoom,
		y: -viewport.y / zoom,
		width: pane.width / zoom,
		height: pane.height / zoom,
	}
	let minX = Number.POSITIVE_INFINITY
	let minY = Number.POSITIVE_INFINITY
	let maxX = Number.NEGATIVE_INFINITY
	let maxY = Number.NEGATIVE_INFINITY
	for (const node of nodes) {
		minX = Math.min(minX, node.x)
		minY = Math.min(minY, node.y)
		maxX = Math.max(maxX, node.x + node.width)
		maxY = Math.max(maxY, node.y + node.height)
	}
	const content = Number.isFinite(minX)
		? {
				x: Math.min(minX, view.x),
				y: Math.min(minY, view.y),
				width: Math.max(maxX, view.x + view.width) - Math.min(minX, view.x),
				height: Math.max(maxY, view.y + view.height) - Math.min(minY, view.y),
			}
		: view
	const scale = Math.max(content.width / MINIMAP_WIDTH, content.height / MINIMAP_HEIGHT, 0.001)
	const offset = MINIMAP_OFFSET * scale
	const viewWidth = scale * MINIMAP_WIDTH + offset * 2
	const viewHeight = scale * MINIMAP_HEIGHT + offset * 2
	const x = content.x - (viewWidth - content.width) / 2
	const y = content.y - (viewHeight - content.height) / 2
	return h.div(
		[
			h.Class(
				"react-flow__panel bottom right react-flow__minimap pointer-events-none !bg-surface-sunken !border-border max-sm:hidden",
			),
			// The stylesheet's mask rule beats a `fill` attribute, so the dark mask goes through its variable.
			h.Style({ "--xy-minimap-mask-background-color-props": MINIMAP_MASK }),
		],
		[
			h.svg(
				[
					h.Attribute("width", String(MINIMAP_WIDTH)),
					h.Attribute("height", String(MINIMAP_HEIGHT)),
					h.Class("react-flow__minimap-svg"),
					h.Role("img"),
					h.AriaLabel("Service map overview"),
					h.Attribute("viewBox", `${x} ${y} ${viewWidth} ${viewHeight}`),
				],
				[
					rects,
					h.path([
						h.Class("react-flow__minimap-mask"),
						h.Attribute("fill", MINIMAP_MASK),
						h.Attribute("fill-rule", "evenodd"),
						h.Attribute(
							"d",
							`M${x},${y}h${viewWidth}v${viewHeight}h${-viewWidth}z M${view.x},${view.y}h${view.width}v${view.height}h${-view.width}z`,
						),
					]),
					// The viewport outline, kept at 1px whatever the minimap's scale.
					h.rect([
						h.Class("fill-none stroke-foreground/60"),
						h.Attribute("x", String(view.x)),
						h.Attribute("y", String(view.y)),
						h.Attribute("width", String(view.width)),
						h.Attribute("height", String(view.height)),
						h.Attribute("stroke-width", "1"),
						h.Attribute("vector-effect", "non-scaling-stroke"),
					]),
				],
			),
		],
	)
}
