import { httpStatusTone } from "@maple/ui/lib/http"
import { TONE_SOFT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { badgeVariants } from "@maple/ui/styles/ui/badge"
import { copyableBadgeStyles } from "@maple/ui/styles/ui/copyable-badge"
import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "./display"
import { icon } from "./icon"
import { serviceDot } from "./values"

// Ports of `TraceIdBadge`, `TraceStatusBadge` (packages/ui/src/components/traces/trace-status-badge.tsx) and
// `ServicePills` (packages/ui/src/components/service-pills.tsx).
// TODO(tooltip): the pills' tooltip listing every service is not ported; the trigger markup is.

/** The root's HTTP status toned by class (3xx keeps its own blue), else OK / Error. */
export const traceStatusBadge = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ hasError: boolean; httpStatusCode?: number | null; className?: string }>,
): Html => {
	const code = options.httpStatusCode
	if (code === undefined || code === null) {
		return badge(
			h,
			{
				variant: "secondary",
				className: cn(TONE_SOFT[options.hasError ? "crit" : "ok"], options.className),
			},
			[options.hasError ? "Error" : "OK"],
		)
	}
	const tone = httpStatusTone(code)
	return badge(
		h,
		{
			variant: "secondary",
			className: cn(
				tone !== "neutral"
					? TONE_SOFT[tone]
					: code >= 300
						? "bg-chart-p50/15 text-chart-p50"
						: TONE_SOFT.ok,
				options.className,
			),
		},
		[String(code)],
	)
}

const VISIBLE_SERVICES = 3

export const servicePills = <M>(h: HtmlBuilder<M>, services: ReadonlyArray<string>): Html | null =>
	services.length === 0
		? null
		: h.div(
				[
					h.Class("flex min-w-0 flex-wrap gap-1"),
					h.DataAttribute("base-ui-tooltip-trigger", ""),
					h.DataAttribute("slot", "tooltip-trigger"),
				],
				[
					...services
						.slice(0, VISIBLE_SERVICES)
						.map((service) =>
							badge(h, { variant: "outline", className: "max-w-full font-mono text-3xs" }, [
								serviceDot(h, { serviceName: service, size: "sm" }),
								h.span([h.Class("truncate")], [service]),
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

/** `TraceIdBadge` (`CopyableBadge` + id glyph); `onCopy` is the page's copy of the id. */
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
			h.Type("button"),
			...(options.onCopy === undefined ? [] : [h.OnClick(options.onCopy)]),
		],
		[
			icon(h, "IdBadgeIcon", { className: "text-muted-foreground" }),
			h.span([h.Class("min-w-0 truncate")], [traceId]),
		],
	)
