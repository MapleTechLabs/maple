import { formatUtcTitle } from "../../lib/time"
import { formatTimestamp, type TimeFormat } from "../kit/local-time"
import { getSeverityColor } from "@maple/ui/lib/severity"
import { cn } from "@maple/ui/lib/utils"
import { badge } from "@maple/web/ui/display"
import { skeleton, skeletonList } from "@maple/web/ui/skeleton"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { failureWithoutData, isPending } from "../../data/slot"
import * as LogSheetView from "../kit/log-sheet/view"
import { Message } from "./message"
import type { PanelModel, SpanLog } from "./panel-model"

// The span's logs, newest first.
// A row click opens `LogDetailSheet` on that log.

type H = HtmlBuilder<Message>

/** `SeverityBadge` from the text only (`severityLabel` with no number). */
const severityBadge = (h: H, severityText: string): Html => {
	const label = severityText.trim() === "" ? "UNSET" : severityText
	const color = getSeverityColor(label)
	return badge(
		h,
		{
			variant: "secondary",
			className: cn("font-mono text-3xs uppercase", "shrink-0"),
			attributes: [
				h.Style({ color, "background-color": `color-mix(in oklch, ${color} 10%, transparent)` }),
			],
		},
		[label],
	)
}

const logRow = (h: H, log: SpanLog, nowMs: number, timeFormat: TimeFormat): Html =>
	h.button(
		[
			h.Key(log.key),
			h.Type("button"),
			h.Class("flex w-full cursor-pointer flex-col gap-1 p-2 text-left hover:bg-muted/30"),
			h.OnClick(Message.ClickedSpanLog({ log })),
		],
		[
			h.div(
				[h.Class("flex items-center gap-2 text-[10px] text-muted-foreground")],
				[
					h.span(
						[h.Class("font-mono"), h.Title(formatUtcTitle(log.timestamp))],
						[formatTimestamp(timeFormat, log.timestamp, { nowMs })],
					),
					severityBadge(h, log.severityText),
				],
			),
			h.p([h.Class("line-clamp-3 whitespace-pre-wrap break-all font-mono text-xs")], [log.body]),
		],
	)

/** The rows, then the sheet beside them. */
export const spanLogs = (
	h: H,
	panel: PanelModel,
	nowMs: number,
	timeFormat: TimeFormat,
): ReadonlyArray<Html> => {
	if (isPending(panel.logs))
		return [
			skeletonList(h, {
				rows: 3,
				gap: "2",
				className: "p-2",
				renderRow: () =>
					h.div([h.Class("space-y-1")], [skeleton(h, "h-3 w-24"), skeleton(h, "h-4 w-full")]),
			}),
		]
	if (Option.isSome(failureWithoutData(panel.logs)))
		return [h.div([h.Class("p-4 text-center text-sm text-destructive")], ["Failed to load logs"])]
	const logs = Option.getOrElse(AsyncData.getData(panel.logs.data), () => [])
	if (logs.length === 0)
		return [
			h.div(
				[h.Class("p-4 text-center text-sm text-muted-foreground")],
				["No logs found for this span"],
			),
		]
	const sheet = Option.match(panel.maybeLogSheet, {
		onNone: () => [],
		onSome: (model) => [
			h.submodel({
				slotId: "span-log-sheet",
				model,
				view: LogSheetView.view,
				viewInputs: { timeFormat },
				toParentMessage: (message) => Message.GotLogSheetMessage({ message }),
			}),
		],
	})
	return [
		h.div(
			[h.Class("divide-y")],
			logs.map((log) => logRow(h, log, nowMs, timeFormat)),
		),
		...sheet,
	]
}
