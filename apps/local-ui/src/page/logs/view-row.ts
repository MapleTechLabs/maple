import { formatUtcTitle } from "../../lib/time"
import { ROW_LINE_CHARS } from "@maple/web/lib/display-text"
import { formatTimestamp, type TimeFormat } from "../kit/local-time"
import { countLabel } from "@maple/ui/lib/format"
import { getSeverityColor } from "@maple/ui/lib/severity"
import { cn } from "@maple/ui/lib/utils"
import { badge } from "@maple/web/ui/display"
import { CHIP_CLASS, CHIP_TONE_CLASSES } from "@maple/web/ui/logs/styles"
import { serviceDot } from "@maple/web/ui/values"
import { Option } from "effect"
import type { Html } from "foldkit/html"
import type { LogsViewBuilder } from "./composition"
import { firstLineOf, rowChips, severityLabel } from "./derive"
import { Message } from "./message"
import type { ChipRef, LocalLog } from "./model"
import { logKey } from "./stream"
import { highlightedText } from "./view-highlight"

// One log row: one 36 px line of the virtualized stream.

/** Left-edge rail (and, for errors, a tint) so a scan down the stream stops on what is wrong. */
const SEVERITY_ROW: ReadonlyMap<string, string> = new Map([
	["FATAL", "before:bg-severity-error bg-severity-error/[0.08]"],
	["CRITICAL", "before:bg-severity-error bg-severity-error/[0.08]"],
	["ERROR", "before:bg-severity-error bg-severity-error/[0.05]"],
	["WARN", "before:bg-severity-warn"],
	["WARNING", "before:bg-severity-warn"],
])

/** Debug and trace chatter is read last, so its message is set back a step. */
const QUIET_SEVERITIES = new Set(["DEBUG", "TRACE"])

/** The anchor a chip's hover card is placed under. */
export const chipId = (chip: ChipRef): string => `log-chip-${chip.index}-${chip.key}`

const chipsView = (h: LogsViewBuilder, log: LocalLog, index: number): ReadonlyArray<Html> => {
	const chips = rowChips(log)
	const key = logKey(log)
	if (chips.length === 0) return []
	return [
		h.div(
			[h.Class("hidden h-5 min-w-0 max-w-[30%] flex-wrap items-center justify-end gap-1 overflow-hidden md:flex")],
			chips.map((chip) => {
				const ref = { index, logKey: key, key: chip.key }
				return h.button(
					[
						h.Type("button"),
						h.Id(chipId(ref)),
						h.AriaLabel(`Copy ${chip.key}=${chip.value}`),
						h.Class(cn(CHIP_CLASS, CHIP_TONE_CLASSES[chip.tone])),
						h.OnMouseEnter(Message.EnteredChip({ chip: ref })),
						h.OnMouseLeave(Message.LeftChip({ chip: ref })),
						h.OnFocus(Message.FocusedChip({ chip: ref })),
						h.OnBlur(Message.BlurredChip({ chip: ref })),
						h.OnClick(Message.ClickedChip({ text: `${chip.key}=${chip.value}` }), { propagation: "Stop" }),
						h.OnKeyDownPreventDefault((pressed) =>
							pressed === "Escape" ? Option.some(Message.PressedChipEscape({ chip: ref })) : Option.none(),
						),
					],
					[
						h.span([h.Class("shrink-0 opacity-70")], [chip.displayKey]),
						h.span([h.Class("shrink-0 opacity-40")], [":"]),
						h.span([h.Class("min-w-0 truncate")], [chip.displayValue]),
					],
				)
			}),
		),
	]
}

export const logRow = (
	h: LogsViewBuilder,
	options: Readonly<{ log: LocalLog; index: number; search: string | undefined; top: number; isSelected: boolean; nowMs: number; timeFormat: TimeFormat }>,
): Html => {
	const { log, search } = options
	const firstLine = firstLineOf(log.body, search)
	const severity = severityLabel(log.severityText, log.severityNumber).toUpperCase()
	const open = Message.ClickedLog({ log })
	return h.div(
		[
			...(options.isSelected ? [h.DataAttribute("selected", "true")] : []),
			h.Style({
				position: "absolute",
				"inset-inline": "0px",
				top: "0px",
				transform: `translateY(${options.top}px)`,
				height: "36px",
			}),
			h.Class(
				cn(
					"flex cursor-pointer items-center gap-3 border-b px-4 font-mono text-xs",
					"before:absolute before:inset-y-0 before:left-0 before:w-0.5",
					"hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none data-[selected]:bg-primary/5",
					SEVERITY_ROW.get(severity),
				),
			),
			h.Tabindex(0),
			h.Role("listitem"),
			h.AriaLabel(`${severity} ${log.serviceName}: ${log.body.slice(0, 120)}`),
			h.OnClick(open),
			h.OnKeyDownPreventDefault((key) => (key === "Enter" || key === " " ? Option.some(open) : Option.none())),
		],
		[
			h.span(
				[h.Class("w-36 shrink-0 truncate text-foreground/75 tabular-nums"), h.Title(formatUtcTitle(log.timestamp))],
				[formatTimestamp(options.timeFormat, log.timestamp, { nowMs: options.nowMs })],
			),
			h.span(
				[
					h.Class(
						"hidden w-11 shrink-0 truncate text-3xs font-semibold tracking-wide uppercase tabular-nums md:inline-block",
					),
					h.Style({ color: getSeverityColor(severity) }),
					h.Title(severity),
				],
				[severity],
			),
			h.span(
				[h.Class("hidden w-32 min-w-0 shrink-0 items-center gap-1.5 text-muted-foreground lg:flex")],
				[
					serviceDot(h, { serviceName: log.serviceName, size: "sm" }),
					h.span([h.Class("truncate"), h.Title(log.serviceName)], [log.serviceName]),
				],
			),
			h.span(
				[h.Class("flex min-w-[40%] flex-1 items-center gap-2"), h.Title(log.body.slice(0, ROW_LINE_CHARS))],
				[
					h.span(
						[
							h.Class(
								cn(
									"min-w-0 truncate",
									QUIET_SEVERITIES.has(severity) ? "text-muted-foreground" : "text-foreground",
								),
							),
						],
						highlightedText(h, firstLine.text, search),
					),
					...(firstLine.hidden > 0
						? [badge(h, { variant: "meta", size: "xs", className: "shrink-0" }, ["+", countLabel(firstLine.hidden, "line")])]
						: []),
				],
			),
			...chipsView(h, log, options.index),
		],
	)
}
