import {
	getPlatformColor,
	getServiceMapNodeColor,
	type ServiceMapColorMode,
} from "@maple/ui/components/service-map/service-map-utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { statusDot } from "../../ui/status-dot"

// `ServiceMapLegend` (packages/ui `service-map/service-map-canvas.tsx`). The "+N more" popover
// trigger renders closed; its popup is not ported in this spike.

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

export const serviceMapLegend = <M>(
	h: HtmlBuilder<M>,
	colorMode: ServiceMapColorMode,
	services: ReadonlyArray<string>,
): Html =>
	h.div(
		[
			h.Class(
				"flex flex-wrap items-center gap-x-4 gap-y-2 border-t bg-muted/30 px-3 py-2.5 text-2xs text-muted-foreground shrink-0",
			),
		],
		[
			h.span([h.Class("font-medium max-sm:hidden")], ["Drag nodes to arrange"]),
			h.span([h.Class("text-foreground/30 max-sm:hidden")], ["|"]),
			h.span([h.Class("font-medium max-sm:hidden")], ["Scroll to zoom"]),
			...(colorMode === "service" && services.length > 0
				? [
						h.span([h.Class("text-foreground/30 max-sm:hidden")], ["|"]),
						...services
							.slice(0, 3)
							.map((service) => swatch(h, serviceSwatchColor(service), service)),
						...(services.length > 3
							? [
									h.button(
										[
											h.AriaExpanded(false),
											h.AriaHasPopup("dialog"),
											h.Class(
												"font-medium hover:text-foreground transition-colors cursor-pointer",
											),
											h.Attribute("data-base-ui-click-trigger", ""),
											h.DataAttribute("slot", "popover-trigger"),
											h.Tabindex(0),
											h.Type("button"),
										],
										["+", String(services.length - 3), " more"],
									),
								]
							: []),
					]
				: []),
			...(colorMode === "platform"
				? [
						h.span([h.Class("text-foreground/30")], ["|"]),
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
