import type { Html, HtmlBuilder } from "foldkit/html"
import { pressable } from "../../ui/pressable"
import { Message, type Model } from "./canvas"
import type { PlacedNode } from "./geometry"
import { measuredBounds } from "./viewport"

// React Flow's stock `<Controls>`, `<MiniMap>` and `<Background variant="dots">`.

const svgPath = <M>(h: HtmlBuilder<M>, viewBox: string, d: string): Html =>
	h.svg(
		[h.Attribute("xmlns", "http://www.w3.org/2000/svg"), h.Attribute("viewBox", viewBox)],
		[h.path([h.Attribute("d", d)])],
	)

const PLUS = "M32 18.133H18.133V32h-4.266V18.133H0v-4.266h13.867V0h4.266v13.867H32z"
const MINUS = "M0 0h32v4.2H0z"
const FIT =
	"M3.692 4.63c0-.53.4-.938.939-.938h5.215V0H4.708C2.13 0 0 2.054 0 4.63v5.216h3.692V4.631zM27.354 0h-5.2v3.692h5.17c.53 0 .984.4.984.939v5.215H32V4.631A4.624 4.624 0 0027.354 0zm.954 24.83c0 .532-.4.94-.939.94h-5.215v3.768h5.215c2.577 0 4.631-2.13 4.631-4.707v-5.139h-3.692v5.139zm-23.677.94c-.531 0-.939-.4-.939-.94v-5.138H0v5.139c0 2.577 2.13 4.707 4.708 4.707h5.138V25.77H4.631z"

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

/** `<Controls showInteractive={false} />`. */
export const controls = <M>(h: HtmlBuilder<M>, model: Model, toMessage: (message: Message) => M): Html =>
	h.div(
		[
			h.Class("react-flow__panel react-flow__controls vertical bottom left"),
			h.DataAttribute("testid", "rf__controls"),
			h.AriaLabel("Control Panel"),
		],
		[
			controlButton(
				h,
				"zoomin",
				"Zoom In",
				model.viewport.zoom >= model.maxZoom,
				toMessage(Message.ClickedZoomIn()),
				svgPath(h, "0 0 32 32", PLUS),
			),
			controlButton(
				h,
				"zoomout",
				"Zoom Out",
				model.viewport.zoom <= model.minZoom,
				toMessage(Message.ClickedZoomOut()),
				svgPath(h, "0 0 32 5", MINUS),
			),
			controlButton(
				h,
				"fitview",
				"Fit View",
				false,
				toMessage(Message.ClickedFitView()),
				svgPath(h, "0 0 32 30", FIT),
			),
		],
	)

/** Read once: React Flow picks the minimap's shape rendering from the browser. */
const MINIMAP_NODE_RENDERING =
	typeof window !== "undefined" && "chrome" in window ? "crispEdges" : "geometricPrecision"

const MINIMAP_WIDTH = 200
const MINIMAP_HEIGHT = 150
const OFFSET_SCALE = 5

/** `<MiniMap>` (not pannable, not zoomable) with a per-node colour and the stock mask. */
export const miniMap = <M>(
	h: HtmlBuilder<M>,
	model: Model,
	nodes: ReadonlyArray<PlacedNode>,
	options: {
		readonly className: string
		readonly maskColor: string
		readonly nodeColor: (id: string) => string
	},
): Html => {
	const { viewport, pane } = model
	const view = {
		x: -viewport.x / viewport.zoom,
		y: -viewport.y / viewport.zoom,
		width: pane.width / viewport.zoom,
		height: pane.height / viewport.zoom,
	}
	const nodeBounds = measuredBounds(nodes)
	const bounds =
		nodeBounds === undefined
			? view
			: {
					x: Math.min(nodeBounds.x, view.x),
					y: Math.min(nodeBounds.y, view.y),
					width:
						Math.max(nodeBounds.x + nodeBounds.width, view.x + view.width) -
						Math.min(nodeBounds.x, view.x),
					height:
						Math.max(nodeBounds.y + nodeBounds.height, view.y + view.height) -
						Math.min(nodeBounds.y, view.y),
				}
	const scale = Math.max(bounds.width / MINIMAP_WIDTH, bounds.height / MINIMAP_HEIGHT)
	const viewWidth = scale * MINIMAP_WIDTH
	const viewHeight = scale * MINIMAP_HEIGHT
	const offset = OFFSET_SCALE * scale
	const x = bounds.x - (viewWidth - bounds.width) / 2 - offset
	const y = bounds.y - (viewHeight - bounds.height) / 2 - offset
	const width = viewWidth + offset * 2
	const height = viewHeight + offset * 2
	return h.div(
		[
			h.Class(`react-flow__panel react-flow__minimap ${options.className} bottom right`),
			h.DataAttribute("testid", "rf__minimap"),
			h.Style({ "--xy-minimap-mask-background-color-props": options.maskColor }),
		],
		[
			h.svg(
				[
					h.Attribute("width", String(MINIMAP_WIDTH)),
					h.Attribute("height", String(MINIMAP_HEIGHT)),
					h.Attribute("viewBox", `${x} ${y} ${width} ${height}`),
					h.Class("react-flow__minimap-svg"),
					h.Role("img"),
					h.Attribute("aria-labelledby", "react-flow__minimap-desc-1"),
				],
				[
					h.title([h.Id("react-flow__minimap-desc-1")], ["Mini Map"]),
					...nodes.flatMap((node) =>
						node.measured === undefined
							? []
							: [
									h.rect([
										h.Class("react-flow__minimap-node"),
										h.Attribute("x", String(node.position.x)),
										h.Attribute("y", String(node.position.y)),
										h.Attribute("rx", "5"),
										h.Attribute("ry", "5"),
										h.Attribute("width", String(node.measured.width)),
										h.Attribute("height", String(node.measured.height)),
										h.Style({ fill: options.nodeColor(node.id) }),
										h.Attribute("shape-rendering", MINIMAP_NODE_RENDERING),
									]),
								],
					),
					h.path([
						h.Class("react-flow__minimap-mask"),
						h.Attribute(
							"d",
							`M${x - offset},${y - offset}h${width + offset * 2}v${height + offset * 2}h${-width - offset * 2}z
        M${view.x},${view.y}h${view.width}v${view.height}h${-view.width}z`,
						),
						h.Attribute("fill-rule", "evenodd"),
						h.Attribute("pointer-events", "none"),
					]),
				],
			),
		],
	)
}

/** `<Background variant="dots" gap size>`: a dot pattern that tracks the camera. */
export const dotBackground = <M>(h: HtmlBuilder<M>, model: Model, gap: number, size: number): Html => {
	const { x, y, zoom } = model.viewport
	const scaledGap = gap * zoom || 1
	const scaledSize = size * zoom
	const offset = scaledGap / 2
	return h.svg(
		[
			h.Class("react-flow__background"),
			h.DataAttribute("testid", "rf__background"),
			h.Style({ position: "absolute", width: "100%", height: "100%", top: "0px", left: "0px" }),
		],
		[
			h.pattern(
				[
					h.Id("pattern-1"),
					h.Attribute("x", String(x % scaledGap)),
					h.Attribute("y", String(y % scaledGap)),
					h.Attribute("width", String(scaledGap)),
					h.Attribute("height", String(scaledGap)),
					h.Attribute("patternUnits", "userSpaceOnUse"),
					h.Attribute("patternTransform", `translate(-${offset},-${offset})`),
				],
				[
					h.circle([
						h.Attribute("cx", String(scaledSize / 2)),
						h.Attribute("cy", String(scaledSize / 2)),
						h.Attribute("r", String(scaledSize / 2)),
						h.Class("react-flow__background-pattern dots"),
					]),
				],
			),
			h.rect([
				h.Attribute("x", "0"),
				h.Attribute("y", "0"),
				h.Attribute("width", "100%"),
				h.Attribute("height", "100%"),
				h.Attribute("fill", "url(#pattern-1)"),
			]),
		],
	)
}
