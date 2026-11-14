import { httpStatusTone } from "@maple/ui/lib/http"
import { cn } from "@maple/ui/lib/utils"
import { badgeVariants } from "./badge.styles"
import { copyableBadgeStyles } from "./copyable-badge.styles"
import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "./display"
import { icon } from "./icon"
import { tooltipTrigger } from "./tooltip-host"
import { serviceLabel } from "./service-label"
import { Array as Arr } from "effect"

// A trace's id badge, status badge and service pills.

/** The root's HTTP status toned by class (3xx keeps its own blue), else OK / Error. */
export const traceStatusBadge = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ hasError: boolean; httpStatusCode?: number | null; className?: string }>,
): Html => {
	const code = options.httpStatusCode
	if (code === undefined || code === null) {
		return badge(h, { variant: options.hasError ? "crit" : "ok", className: options.className }, [
			options.hasError ? "Error" : "OK",
		])
	}
	const tone = httpStatusTone(code)
	// 3xx has no status tone: it keeps its own blue on the neutral chip.
	const redirect = tone === "neutral" && code >= 300
	return badge(
		h,
		{
			variant: tone !== "neutral" ? tone : redirect ? "secondary" : "ok",
			className: cn(redirect ? "bg-chart-p50/15 text-chart-p50" : undefined, options.className),
		},
		[String(code)],
	)
}

const VISIBLE_SERVICES = 3

/** `tooltipServices`: the services the tooltip lists, when the pills draw only some. */
export const servicePills = <M>(
	h: HtmlBuilder<M>,
	services: ReadonlyArray<string>,
	tooltipServices: ReadonlyArray<string> = services,
): Html | null =>
	services.length === 0
		? null
		: h.div(
				[
					h.Class("flex min-w-0 flex-wrap gap-1"),
					h.DataAttribute("base-ui-tooltip-trigger", ""),
					h.DataAttribute("slot", "tooltip-trigger"),
					...tooltipTrigger(h, Arr.join(tooltipServices, "\n")),
				],
				[
					...Arr.map(services.slice(0, VISIBLE_SERVICES), (service) =>
						badge(h, { variant: "outline", className: "max-w-full text-3xs" }, [
							serviceLabel(h, { serviceName: service, dot: "sm" }),
						]),
					),
					...(services.length > VISIBLE_SERVICES
						? [
								badge(h, { variant: "outline", className: "text-3xs" }, [
									"+",
									String(services.length - VISIBLE_SERVICES),
								]),
							]
						: []),
				],
			)

/** A copyable badge with the id glyph; `onCopy` is the page's copy of the id. */
export const traceIdBadge = <M>(
	h: HtmlBuilder<M>,
	traceId: string,
	options: Readonly<{ size?: "default" | "lg" | "sm"; className?: string; onCopy?: M }> = {},
): Html =>
	h.button(
		[
			h.AriaLabel("Copy trace ID"),
			h.Class(
				cn(
					badgeVariants({ variant: "outline", size: options.size ?? "lg" }),
					copyableBadgeStyles,
					cn("gap-1.5 font-mono", options.className),
				),
			),
			h.DataAttribute("base-ui-tooltip-trigger", ""),
			h.DataAttribute("slot", "tooltip-trigger"),
			...(options.onCopy === undefined ? [] : tooltipTrigger(h, "Copy trace ID")),
			h.Type("button"),
			...(options.onCopy === undefined ? [] : [h.OnClick(options.onCopy)]),
		],
		[
			icon(h, "IdBadgeIcon", { className: "text-muted-foreground" }),
			h.span([h.Class("min-w-0 truncate")], [traceId]),
		],
	)
