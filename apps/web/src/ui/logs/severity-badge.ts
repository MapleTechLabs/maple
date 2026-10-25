import { getSeverityColor } from "@maple/ui/lib/severity"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "../display"
import { severityLabel } from "./log-row-view"

// `SeverityBadge` (packages/ui/src/components/logs/severity-badge.tsx).

export type SeverityBadgeOptions = Readonly<{ severity: string; severityNumber?: number; className?: string }>

/** The log's severity in its own colour over a 10% wash of it. */
export const severityBadge = <M>(h: HtmlBuilder<M>, options: SeverityBadgeOptions): Html => {
	const label = severityLabel(options.severity, options.severityNumber)
	const color = getSeverityColor(label)
	return badge(
		h,
		{
			variant: "secondary",
			className: cn("font-mono text-3xs uppercase", options.className),
			attributes: [
				h.Style({ color, "background-color": `color-mix(in oklch, ${color} 10%, transparent)` }),
			],
		},
		[label],
	)
}
