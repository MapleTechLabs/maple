import type { Html, HtmlBuilder } from "foldkit/html"
import { pageBody, pageContent } from "../../page/kit/dashboard-page"
import { viewportView } from "../../page/service-map/view-scene3d"
import { statusDot } from "../../ui/status-dot"
import { Message, type Model } from "./update"
import { inspector } from "./view-inspector"
import { inventory, topology } from "./view-inventory"

// `ServiceMap3DLab`: `DashboardLayout.Body` > `Content`, the title bar, then viewport and rail.

const titleBar = (h: HtmlBuilder<Message>): Html =>
	h.div(
		[h.Class("flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-5 py-4")],
		[
			h.div(
				[],
				[
					h.div(
						[h.Class("flex items-center gap-3")],
						[
							h.h1([h.Class("font-display text-lg font-semibold tracking-tight")], ["Service map"]),
							h.span([h.Class("rounded-sm border px-1.5 py-0.5 text-3xs text-muted-foreground")], ["Isometric lab"]),
						],
					),
					h.p([h.Class("mt-1 text-xs text-muted-foreground")], ["Every service a machine, every call a belt."]),
				],
			),
			h.div(
				[h.Class("flex items-center gap-2 text-2xs text-muted-foreground")],
				[
					statusDot(h, { tone: "custom", className: "bg-muted-foreground" }),
					"Sample topology",
					h.span(
						[h.Class("ml-2 border-l pl-3")],
						[`${topology.nodes.length} nodes · ${topology.edges.length} connections`],
					),
				],
			),
		],
	)

export const view = (model: Model, h: HtmlBuilder<Message>): Html => {
	const selected = model.selectedId === null ? undefined : topology.nodes.find((node) => node.id === model.selectedId)
	return pageBody(h, [
		pageContent(h, [
			h.div(
				[h.Class("flex h-full min-h-0 flex-col overflow-y-auto xl:overflow-hidden")],
				[
					titleBar(h),
					h.div(
						[h.Class("grid flex-1 grid-cols-1 xl:min-h-0 xl:grid-cols-[minmax(0,1fr)_256px]")],
						[
							h.div(
								[h.Class("h-[600px] min-h-0 xl:h-auto")],
								[
									viewportView(h, {
										model: model.scene,
										topology,
										selectedId: model.selectedId,
										reducedMotion: model.reducedMotion,
										sample: true,
										toMessage: (message) => Message.GotSceneMessage({ message }),
									}),
								],
							),
							selected === undefined ? inventory(h, model) : inspector(h, selected),
						],
					),
				],
			),
		]),
	])
}
