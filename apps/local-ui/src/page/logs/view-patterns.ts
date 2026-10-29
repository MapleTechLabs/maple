import { rankCounts, severityBreakdown, splitTemplate } from "../../lib/log-patterns"
import { getSeverityColor } from "@maple/ui/lib/severity"
import { cn } from "@maple/ui/lib/utils"
import type { Html } from "foldkit/html"
import type { LogsViewBuilder } from "./composition"
import { Message } from "./message"
import type { LogPattern } from "./model"

// The Logs page's patterns list.

const VISIBLE_SERVICES = 2

const patternRow = (h: LogsViewBuilder, pattern: LogPattern, share: number): Html => {
	const services = rankCounts(pattern.serviceCounts)
	const dominant = rankCounts(pattern.severityCounts)[0]?.name ?? "UNKNOWN"
	const percent = share * 100
	return h.li(
		[h.Class("border-b")],
		[
			h.button(
				[
					h.Type("button"),
					h.AriaLabel(`${pattern.count} logs: ${pattern.template.slice(0, 120)}`),
					h.Title("Show matching logs"),
					h.Style({ "border-left-width": "3px", "border-left-color": getSeverityColor(dominant) }),
					h.Class(
						"flex w-full cursor-pointer items-center gap-4 px-4 py-2 text-left hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none",
					),
					h.OnClick(Message.ClickedPattern({ pattern })),
				],
				[
					h.div(
						[h.Class("flex min-w-0 flex-1 flex-col gap-1")],
						[
							h.span(
								[h.Class("truncate font-mono text-xs"), h.Title(pattern.template)],
								splitTemplate(pattern.template).map((segment) =>
									segment.variable
										? h.span([h.Class("text-muted-foreground/50")], [segment.text])
										: h.span([], [segment.text]),
								),
							),
							h.div(
								[h.Class("flex min-w-0 items-center gap-3 text-[11px] text-muted-foreground")],
								[
									h.span(
										[h.Class("flex shrink-0 items-center gap-2")],
										severityBreakdown(pattern.severityCounts).map((entry) =>
											h.span(
												[
													h.Class("font-semibold uppercase tabular-nums"),
													h.Style({ color: getSeverityColor(entry.name) }),
												],
												[entry.name, " ", entry.count.toLocaleString()],
											),
										),
									),
									h.span(
										[
											h.Class("hidden shrink-0 truncate lg:inline"),
											h.Title(services.map((s) => `${s.name} (${s.count})`).join(", ")),
										],
										[
											services
												.slice(0, VISIBLE_SERVICES)
												.map((s) => s.name)
												.join(", "),
											services.length > VISIBLE_SERVICES ? ` +${services.length - VISIBLE_SERVICES}` : "",
										],
									),
									h.span(
										[h.Class("min-w-0 truncate font-mono text-muted-foreground/70"), h.Title(pattern.sample)],
										[pattern.sample],
									),
								],
							),
						],
					),
					shareColumn(h, pattern.count, percent),
				],
			),
		],
	)
}

const shareColumn = (h: LogsViewBuilder, count: number, percent: number): Html =>
	h.div(
		[h.Class("flex w-28 shrink-0 flex-col items-end gap-1")],
		[
			h.span([h.Class("font-mono text-xs tabular-nums")], [count.toLocaleString()]),
			h.div(
				[h.Class("flex w-full items-center gap-1.5")],
				[
					h.div(
						[h.Class("h-1 flex-1 overflow-hidden rounded-full bg-muted")],
						[h.div([h.Class("h-full rounded-full bg-primary/70"), h.Style({ width: `${percent}%` })], [])],
					),
					h.span(
						[h.Class("w-9 text-right text-[10px] text-muted-foreground tabular-nums")],
						[percent < 1 ? "<1%" : `${Math.round(percent)}%`],
					),
				],
			),
		],
	)

export const patternsList = (
	h: LogsViewBuilder,
	options: Readonly<{ patterns: ReadonlyArray<LogPattern>; totalSampled: number; isDimmed: boolean }>,
): Html =>
	h.ul(
		[h.AriaLabel("Log patterns"), h.Class(cn("h-full overflow-auto", options.isDimmed && "opacity-60 transition-opacity"))],
		options.patterns.map((pattern) =>
			patternRow(h, pattern, options.totalSampled > 0 ? pattern.count / options.totalSampled : 0),
		),
	)
