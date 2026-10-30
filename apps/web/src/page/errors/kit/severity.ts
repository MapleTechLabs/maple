import type { IssueSeverity } from "@maple/domain/http"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "../../../ui/display"
import { icon } from "../../../ui/icon"
import { statusDot } from "../../../ui/status-dot"

// The severity badge's maps and marks.

export const SEVERITY_TONE = {
	critical: "bg-severity-fatal/12 text-severity-fatal",
	high: "bg-severity-error/12 text-severity-error",
	medium: "bg-severity-warn/12 text-severity-warn",
	low: "bg-severity-debug/12 text-severity-debug",
} satisfies Record<IssueSeverity, string>

export const SEVERITY_FILL = {
	critical: "bg-severity-fatal",
	high: "bg-severity-error",
	medium: "bg-severity-warn",
	low: "bg-severity-debug",
} satisfies Record<IssueSeverity, string>

export const SEVERITY_TOKEN = {
	critical: "--severity-fatal",
	high: "--severity-error",
	medium: "--severity-warn",
	low: "--severity-debug",
} satisfies Record<IssueSeverity, `--${string}`>

export const SEVERITY_TEXT = {
	critical: "text-severity-fatal",
	high: "text-severity-error",
	medium: "text-severity-warn",
	low: "text-severity-debug",
} satisfies Record<IssueSeverity, string>

export const SEVERITY_LABEL = {
	critical: "Critical",
	high: "High",
	medium: "Medium",
	low: "Low",
} satisfies Record<IssueSeverity, string>

export const SEVERITY_ORDER: ReadonlyArray<IssueSeverity> = ["critical", "high", "medium", "low"]

/** Sort rank: critical first, unset last. */
export const severityRank = (severity: IssueSeverity | null): number =>
	severity === null ? SEVERITY_ORDER.length : SEVERITY_ORDER.indexOf(severity)

/** `SeverityDot`: a filled dot, or a hollow ring for "not set". */
export const severityDot = <M>(h: HtmlBuilder<M>, severity: IssueSeverity | null, className?: string): Html =>
	statusDot(h, {
		tone: "custom",
		size: "lg",
		className: cn(
			severity === null ? "border border-foreground-subtle" : SEVERITY_FILL[severity],
			className,
		),
	})

/** `SeverityBadge`: blank for "not set", so the lane keeps its width without a mark. */
export const severityBadge = <M>(
	h: HtmlBuilder<M>,
	severity: IssueSeverity | null,
	className?: string,
): Html =>
	severity === null
		? h.span([h.Class(cn("inline-flex h-5", className)), h.Title("Severity not set")], [])
		: badge(h, { variant: "outline", className: cn(SEVERITY_TONE[severity], className) }, [
				SEVERITY_LABEL[severity],
			])

const SEVERITY_BARS = ["M3 16V18", "M11 12V18", "M19 6V18"]

/** `SeverityIcon`: three blocks for unset, one to three bars, the pixel triangle for critical. */
export const severityIcon = <M>(
	h: HtmlBuilder<M>,
	severity: IssueSeverity | null,
	size = 16,
	className?: string,
): Html => {
	const label = severity === null ? "Severity not set" : SEVERITY_LABEL[severity]
	if (severity === "critical") {
		return icon(h, "PixelTriangleWarningIcon", {
			size,
			className: cn(SEVERITY_TEXT[severity], className),
			attributes: [h.Attribute("role", "img"), h.Attribute("aria-label", label)],
			removedAttributes: ["aria-hidden"],
		})
	}
	const svg = (tone: string, paths: ReadonlyArray<Html>) =>
		h.svg(
			[
				h.Attribute("xmlns", "http://www.w3.org/2000/svg"),
				h.Attribute("viewBox", "0 0 24 24"),
				h.Attribute("width", String(size)),
				h.Attribute("height", String(size)),
				h.Attribute("fill", "none"),
				h.Attribute("stroke", "currentColor"),
				h.Attribute("stroke-width", "4"),
				h.Attribute("stroke-linecap", "square"),
				h.Attribute("role", "img"),
				h.Attribute("aria-label", label),
				h.Attribute("class", cn(tone, className)),
			],
			paths,
		)
	if (severity === null) {
		const blocks = ["M3 12H3.01", "M11 12H11.01", "M19 12H19.01"]
		return svg(
			"text-muted-foreground",
			blocks.map((d) => h.path([h.Attribute("d", d)])),
		)
	}
	const filled = severity === "high" ? 3 : severity === "medium" ? 2 : 1
	return svg(
		SEVERITY_TEXT[severity],
		SEVERITY_BARS.map((d, index) =>
			h.path([h.Attribute("d", d), h.Attribute("opacity", index < filled ? "1" : "0.25")]),
		),
	)
}
