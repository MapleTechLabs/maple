import { TONE_FILL } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "../../../ui/display"
import { panelBody } from "../../../ui/panel"
import {
	type CheckHealth,
	checkHealth,
	displayStatus,
	medianOf,
	type RecentCheck,
	STATUS_TONE,
	statusLabel,
	type UptimeMonitor,
} from "./uptime-derive"

// The uptime marks: the status chip, the status square and the recent-checks strip.

/** The status badge, sentence case ("Down 6m", "Paused"), in the same tinted chip as other status badges. */
export const uptimeStatusChip = <M>(h: HtmlBuilder<M>, monitor: UptimeMonitor, nowMs: number): Html => {
	const tone = STATUS_TONE[displayStatus(monitor)]
	return badge(h, { variant: tone === "neutral" ? "muted" : tone }, [statusLabel(monitor, nowMs)])
}

/** The small square leading a monitor row; static, never animated. */
export const uptimeStatusSquare = <M>(h: HtmlBuilder<M>, monitor: UptimeMonitor): Html =>
	h.span(
		[
			h.AriaHidden(true),
			h.Class(
				cn(
					"inline-block size-2 shrink-0 rounded-[2px]",
					TONE_FILL[STATUS_TONE[displayStatus(monitor)]],
				),
			),
		],
		[],
	)

/** Fill per check health: green fading as checks slow, amber when slow or partly failing, red when failing. */
export const CHECK_HEALTH_FILL = {
	fast: TONE_FILL.ok,
	slower: "bg-severity-info/60",
	slow: "bg-severity-warn/55",
	someFailed: TONE_FILL.warn,
	mostlyFailed: TONE_FILL.crit,
	none: "bg-muted",
} satisfies Record<CheckHealth, string>

/** One bar per check, oldest first, filled by `checkHealth`; an empty slot is muted. */
export const recentChecksStrip = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		recent: ReadonlyArray<RecentCheck>
		slots?: number
		isMuted?: boolean
		className?: string
	}>,
): Html => {
	const slots = options.slots ?? 40
	const recent = options.recent.slice(-slots)
	const padding = Math.max(0, slots - recent.length)
	const passed = recent.filter((check) => check.ok).length
	const medianMs = medianOf(
		recent.flatMap((check) => (check.duration_ms === null ? [] : [check.duration_ms])),
	)
	const label = recent.length === 0 ? "No checks yet" : `${passed} of ${recent.length} recent checks passed`
	return h.div(
		[
			h.Role("img"),
			h.AriaLabel(label),
			h.Title(label),
			h.Class(cn("flex h-5 items-stretch gap-px", options.className)),
		],
		[
			...Array.from({ length: padding }, (_, index) =>
				h.span([h.Key(`pad-${index}`), h.Class("w-1 min-w-0 flex-1 rounded-[1px] bg-muted")], []),
			),
			...recent.map((check, index) =>
				h.span(
					[
						h.Key(`${check.at}-${index}`),
						h.Class(
							cn(
								"w-1 min-w-0 flex-1 rounded-[1px]",
								options.isMuted === true
									? "bg-muted"
									: CHECK_HEALTH_FILL[
											checkHealth(
												{
													total: 1,
													failed: check.ok ? 0 : 1,
													latencyMs: check.duration_ms,
												},
												medianMs,
											)
										],
							),
						),
					],
					[],
				),
			),
		],
	)
}

/** `panelBody` with the inset the uptime panels' rows use. */
export const uptimePanelBody = <M>(h: HtmlBuilder<M>, children: ReadonlyArray<Html>): Html =>
	panelBody(h, children, "px-4 py-3")
