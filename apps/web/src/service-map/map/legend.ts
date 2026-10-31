import {
	getPlatformColor,
	getServiceMapNodeColor,
	type ServiceMapColorMode,
} from "@maple/ui/components/service-map/service-map-utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Popover from "../../ui/popover"
import { statusDot } from "../../ui/status-dot"

// `ServiceMapLegend` (packages/ui `service-map/service-map-canvas.tsx`), with the "+N more"
// popover listing every service.

const LEGEND_PLATFORMS = [
	["kubernetes", "Kubernetes"],
	["cloudflare", "Cloudflare"],
	["gcp", "Google Cloud"],
	["lambda", "Lambda"],
	["web", "Web"],
	["unknown", "Unknown"],
] as const

const swatch = <M>(h: HtmlBuilder<M>, color: string, label: string): Html =>
	h.div(
		[h.Class("flex items-center gap-1.5")],
		[
			h.div([h.Class("size-2.5 rounded-sm shrink-0"), h.Style({ "background-color": color })]),
			h.span([h.Class("font-medium")], [label]),
		],
	)

const serviceSwatchColor = (service: string) =>
	getServiceMapNodeColor({ label: service, kind: "service", errorRate: 0 }, "service")

const health = <M>(h: HtmlBuilder<M>, tone: "ok" | "warn" | "crit", label: string): Html =>
	h.div([h.Class("flex items-center gap-1.5")], [statusDot(h, { tone, size: "lg" }), h.span([], [label])])

/** The popover's grid: every service with its swatch. */
const allServices = <M>(h: HtmlBuilder<M>, services: ReadonlyArray<string>): Html =>
	h.div(
		[h.Class("grid grid-cols-2 gap-2 text-2xs")],
		services.map((service) =>
			h.div(
				[h.Class("flex items-center gap-1.5 min-w-0")],
				[
					h.div([
						h.Class("size-2.5 rounded-sm shrink-0"),
						h.Style({ "background-color": serviceSwatchColor(service) }),
					]),
					h.span([h.Class("truncate font-medium")], [service]),
				],
			),
		),
	)

const morePopover = <M>(
	h: HtmlBuilder<M>,
	services: ReadonlyArray<string>,
	popover: Popover.Model,
	toPopover: (message: Popover.Message) => M,
): Html =>
	h.submodel({
		slotId: "service-map-legend",
		model: popover,
		view: Popover.view,
		toParentMessage: toPopover,
		viewInputs: {
			className: "w-64 p-3",
			toView: ({ trigger, withTrigger }) =>
				h.div(
					[h.Class("contents")],
					withTrigger(
						h.button(
							[
								...trigger,
								h.Class("font-medium hover:text-foreground active:text-foreground cursor-pointer"),
								h.Type("button"),
							],
							["+", String(services.length - 3), " more"],
						),
					),
				),
			toContent: () => [allServices(h, services)],
		},
	})

export const serviceMapLegend = <M>(
	h: HtmlBuilder<M>,
	colorMode: ServiceMapColorMode,
	services: ReadonlyArray<string>,
	popover: Popover.Model,
	toPopover: (message: Popover.Message) => M,
): Html =>
	h.div(
		[
			h.Class(
				"flex flex-wrap items-center gap-x-4 gap-y-2 border-t bg-surface-sunken px-3 py-2.5 text-2xs text-muted-foreground shrink-0",
			),
		],
		[
			h.span([h.Class("font-medium max-sm:hidden")], ["Drag nodes to arrange"]),
			h.span([h.Class("text-foreground-faint max-sm:hidden")], ["·"]),
			h.span([h.Class("font-medium max-sm:hidden")], ["Scroll to zoom"]),
			...(colorMode === "service" && services.length > 0
				? [
						h.span([h.Class("text-foreground-faint max-sm:hidden")], ["·"]),
						...services
							.slice(0, 3)
							.map((service) => swatch(h, serviceSwatchColor(service), service)),
						...(services.length > 3 ? [morePopover(h, services, popover, toPopover)] : []),
					]
				: []),
			...(colorMode === "platform"
				? [
						h.span([h.Class("text-foreground-faint")], ["·"]),
						...LEGEND_PLATFORMS.map(([platform, label]) =>
							swatch(h, getPlatformColor(platform === "unknown" ? undefined : platform), label),
						),
					]
				: []),
			h.span([h.Class("flex-1")]),
			h.div(
				[h.Class("flex items-center gap-3")],
				[health(h, "ok", "Healthy"), health(h, "warn", "Degraded"), health(h, "crit", "Error")],
			),
		],
	)
