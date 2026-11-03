import { rankCounts, severityBreakdown, splitTemplate } from "../../lib/log-patterns"
import { getSeverityColor } from "@maple/ui/lib/severity"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { cn } from "@maple/ui/lib/utils"
import { pressable } from "@maple/views/ui/pressable"
import { hstack, hstackClass, vstack } from "@maple/views/ui/stack"
import { typography, typographyClass } from "@maple/views/ui/typography"
import type { Html, HtmlBuilder } from "foldkit/html"
import { Message } from "./message"
import type { LogPattern } from "./model"

// The Logs page's patterns list.

const VISIBLE_SERVICES = 2

const patternRow = (h: HtmlBuilder<Message>, pattern: LogPattern, share: number): Html => {
	const services = rankCounts(pattern.serviceCounts)
	const dominant = rankCounts(pattern.severityCounts)[0]?.name ?? "UNKNOWN"
	const percent = share * 100
	return h.li(
		[h.Class("border-b")],
		[
			pressable(
				h,
				{
					onClick: Message.ClickedPattern({ pattern }),
					label: `${pattern.count} logs: ${pattern.template.slice(0, 120)}`,
					className: cn(
						hstackClass({ gap: "4" }),
						"w-full px-4 py-2 text-left hover:bg-muted/50 active:bg-muted/50 focus-visible:bg-muted/50",
					),
					attributes: [
						h.Title("Show matching logs"),
						h.Style({
							"border-left-width": "3px",
							"border-left-color": getSeverityColor(dominant),
						}),
					],
				},
				[
					vstack(h, { gap: "1", shrink: true, grow: true }, [
						typography(
							h,
							{
								size: "xs",
								mono: true,
								truncate: true,
								attributes: [h.Title(pattern.template)],
							},
							splitTemplate(pattern.template).map((segment) =>
								segment.variable
									? h.span([h.Class("text-muted-foreground/50")], [segment.text])
									: h.span([], [segment.text]),
							),
						),
						hstack(
							h,
							{
								gap: "3",
								shrink: true,
								className: typographyClass({ size: "2xs", tone: "muted" }),
							},
							[
								hstack(
									h,
									{ as: "span", gap: "2", className: "shrink-0" },
									severityBreakdown(pattern.severityCounts).map((entry) =>
										typography(
											h,
											{
												weight: "semibold",
												numeric: true,
												className: "uppercase",
												attributes: [
													h.Style({ color: getSeverityColor(entry.name) }),
												],
											},
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
										services.length > VISIBLE_SERVICES
											? ` +${services.length - VISIBLE_SERVICES}`
											: "",
									],
								),
								h.span(
									[
										h.Class("min-w-0 truncate font-mono text-muted-foreground/70"),
										h.Title(pattern.sample),
									],
									[pattern.sample],
								),
							],
						),
					]),
					shareColumn(h, pattern.count, percent),
				],
			),
		],
	)
}

const shareColumn = (h: HtmlBuilder<Message>, count: number, percent: number): Html =>
	vstack(h, { gap: "1", align: "end", className: "w-28 shrink-0" }, [
		typography(h, { size: "xs", mono: true, numeric: true }, [count.toLocaleString()]),
		hstack(h, { gap: "1.5", className: "w-full" }, [
			h.div(
				[h.Class("h-1 flex-1 overflow-hidden rounded-full bg-muted")],
				[
					h.div(
						[h.Class("h-full rounded-full bg-primary/70"), h.Style({ width: `${percent}%` })],
						[],
					),
				],
			),
			typography(h, { size: "3xs", tone: "muted", numeric: true, className: "w-9 text-right" }, [
				percent < 1 ? "<1%" : `${Math.round(percent)}%`,
			]),
		]),
	])

export const patternsList = (
	h: HtmlBuilder<Message>,
	options: Readonly<{ patterns: ReadonlyArray<LogPattern>; totalSampled: number; isDimmed: boolean }>,
): Html =>
	h.ul(
		[h.AriaLabel("Log patterns"), h.Class(cn("h-full overflow-auto", refreshingClass(options.isDimmed)))],
		options.patterns.map((pattern) =>
			patternRow(h, pattern, options.totalSampled > 0 ? pattern.count / options.totalSampled : 0),
		),
	)
