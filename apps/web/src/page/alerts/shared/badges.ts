import type { AlertSeverity } from "@maple/domain/http"
import { TONE_TEXT, type Tone } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "@maple/views/ui/display"
import { statusDot } from "@maple/views/ui/status-dot"

// The alert severity and status badges.

const TONE_BY_SEVERITY = new Map<AlertSeverity, "warn" | "crit">([
	["warning", "warn"],
	["critical", "crit"],
])
/** Each alert severity's name. */
export const ALERT_SEVERITY_LABEL = {
	warning: "Warning",
	critical: "Critical",
} as const satisfies Record<AlertSeverity, string>

export const severityBadge = <M>(h: HtmlBuilder<M>, severity: AlertSeverity, className?: string): Html => {
	const tone = TONE_BY_SEVERITY.get(severity) ?? "warn"
	return badge(h, { variant: tone, className }, [ALERT_SEVERITY_LABEL[severity]])
}

export type AlertStatusState =
	| "firing"
	| "ok"
	| "disabled"
	| "resolved"
	| "pending"
	| "error"
	| "stale"
	| "no-data"
	| "held"

const STATUS_TONE = new Map<AlertStatusState, { tone: Tone; strong?: boolean; label: string }>([
	["firing", { tone: "crit", strong: true, label: "Firing" }],
	["ok", { tone: "ok", label: "OK" }],
	["disabled", { tone: "neutral", label: "Disabled" }],
	["resolved", { tone: "done", label: "Resolved" }],
	["pending", { tone: "warn", label: "Pending" }],
	["error", { tone: "warn", strong: true, label: "Error" }],
	["stale", { tone: "warn", label: "Stale" }],
	["no-data", { tone: "neutral", label: "No data" }],
	["held", { tone: "warn", label: "Waiting on data" }],
])

export const alertStatusBadge = <M>(
	h: HtmlBuilder<M>,
	state: AlertStatusState,
	options: Readonly<{ label?: string; className?: string }> = {},
): Html => {
	const meta = STATUS_TONE.get(state) ?? { tone: "neutral", label: state }
	return h.span(
		[
			h.Class(
				cn(
					"inline-flex items-center gap-1.5 text-xs",
					TONE_TEXT[meta.tone],
					meta.strong === true && "font-medium",
					options.className,
				),
			),
		],
		[statusDot(h, { tone: meta.tone }), h.span([], [options.label ?? meta.label])],
	)
}
