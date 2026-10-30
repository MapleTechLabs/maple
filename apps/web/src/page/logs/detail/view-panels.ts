import { formatDuration } from "@maple/domain/format"
import { parseErrorBody } from "@maple/ui/lib/error-body"
import { formatErrorPrompt } from "@maple/ui/lib/error-prompt"
import { shortId } from "@maple/ui/lib/ids"
import { getSeverityColor } from "@maple/ui/lib/severity"
import { cn } from "@maple/ui/lib/utils"
import { formatCompactTimeInTimezone } from "@maple/web-data/lib/timezone-format"
import { Effect } from "effect"
import { AsyncData, Mount } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { ROW_LINE_CHARS } from "../../../lib/display-text"
import { separator } from "../../../ui/display"
import { emptyMessage } from "../../../ui/empty"
import { errorSectionView } from "../../../ui/error-section"
import { errorState } from "../../../ui/error-state"
import type { LogRecord } from "../../../ui/logs/log-row-view"
import { skeleton, skeletonList } from "../../../ui/skeleton"
import * as ToggleGroup from "../../../ui/toggle-group"
import { serviceDot } from "../../../ui/values"
import { severityLabel } from "./derive"
import { Message, type Model } from "./model"
import {
	contextKey,
	instanceAttribute,
	mergeLogContext,
	scopedInstance,
	timestampMs,
	TRACE_LOG_LIMIT,
} from "./panels"
import { copyStatusOf } from "./update"

// The log's error banner, context panel and trace timeline.

type H = HtmlBuilder<Message>

const ROW_CLASS = "flex w-full items-center gap-2 px-2 py-1"
const QUIET_SEVERITIES = new Set(["DEBUG", "TRACE"])

/** `centerSelected`: the selected row centred inside its list only (never scrolling the page). */
export const CenterContextRow = Mount.define("CenterLogContextRow", {
	messages: [Message.PositionedLogRow],
	execute: ({ element }) =>
		Effect.sync(() => {
			const list = element.parentElement
			if (list !== null && element instanceof HTMLElement)
				list.scrollTop = element.offsetTop - (list.clientHeight - element.offsetHeight) / 2
			return Message.PositionedLogRow()
		}),
})

/** `scrollIntoView({ block: "nearest" })` on the timeline's current log. */
const RevealTimelineRow = Mount.define("RevealLogTimelineRow", {
	messages: [Message.PositionedLogRow],
	execute: ({ element }) =>
		Effect.sync(() => {
			element.scrollIntoView({ block: "nearest" })
			return Message.PositionedLogRow()
		}),
})

export const showsErrorBanner = (log: LogRecord): boolean => {
	const severity = severityLabel(log.severityText, log.severityNumber).toUpperCase()
	return severity === "ERROR" || severity === "FATAL"
}

/** `LogErrorBanner`: the exception message (else the body), its type and a prompt to copy. */
export const errorBanner = (h: H, model: Model, log: LogRecord): Html | null => {
	const message = log.logAttributes["exception.message"] ?? log.logAttributes["error.message"] ?? log.body
	if (message === "") return null
	return errorSectionView(h, {
		message,
		title: log.severityText.toUpperCase() === "FATAL" ? "Fatal" : "Error",
		badge: log.logAttributes["exception.type"] ?? log.logAttributes["error.type"],
		isExpanded: model.isErrorExpanded,
		onToggle: Message.ToggledErrorExpanded(),
		bodyStatus: copyStatusOf(model, "error-body"),
		onCopyBody: Message.ClickedCopy({ copyId: "error-body", text: parseErrorBody(message).full }),
		prompt: {
			status: copyStatusOf(model, "error-prompt"),
			onCopy: Message.ClickedCopy({
				copyId: "error-prompt",
				text: formatErrorPrompt({
					message,
					serviceName: log.serviceName,
					attributes: { ...log.logAttributes },
				}),
			}),
		},
	})
}

const rowSkeleton = (h: H, rows: number, widths: readonly [string, string]) =>
	skeletonList(h, {
		rows,
		className: "gap-0 overflow-hidden rounded-md border",
		renderRow: () =>
			h.div(
				[h.Class("flex items-center gap-2 border-b px-2 py-1.5 last:border-b-0")],
				[
					skeleton(h, cn("h-3 shrink-0", widths[0])),
					skeleton(h, cn("h-3 shrink-0", widths[1])),
					skeleton(h, "h-3 flex-1"),
				],
			),
	})

/** `LogTime`: `HH:MM:SS` at full strength, the milliseconds a step back. */
const logTime = (h: H, timestamp: string, timeZone: string): ReadonlyArray<Html | string> => {
	const formatted = formatCompactTimeInTimezone(timestamp, { timeZone })
	const dot = formatted.lastIndexOf(".")
	if (dot === -1) return [formatted]
	return [formatted.slice(0, dot), h.span([h.Class("text-muted-foreground/50")], [formatted.slice(dot)])]
}

const contextList = (
	h: H,
	log: LogRecord,
	rows: ReadonlyArray<LogRecord>,
	timeZone: string,
	className: string | undefined,
): Html => {
	if (rows.length <= 1) return emptyMessage(h, {}, ["No other logs around this one"])
	const selectedKey = contextKey(log)
	return h.ul(
		[
			h.Key(selectedKey),
			h.Class(cn("relative min-h-0 flex-1 overflow-y-auto rounded-md border", className)),
		],
		rows.map((row) => {
			const key = contextKey(row)
			const isCurrent = key === selectedKey
			const cells = [
				h.span(
					[h.Class("w-[92px] shrink-0 tabular-nums text-foreground/70")],
					logTime(h, row.timestamp, timeZone),
				),
				h.span(
					[
						h.Class(
							"w-11 shrink-0 text-3xs font-semibold uppercase leading-4 tracking-wide tabular-nums",
						),
						h.Style({ color: getSeverityColor(row.severityText) }),
					],
					[row.severityText],
				),
				h.span(
					[
						h.Class(
							cn(
								"min-w-0 flex-1 truncate",
								isCurrent
									? "text-foreground"
									: QUIET_SEVERITIES.has(row.severityText.toUpperCase())
										? "text-muted-foreground"
										: "text-foreground/80",
							),
						),
					],
					[(row.body.split("\n", 1)[0] ?? "").slice(0, ROW_LINE_CHARS)],
				),
			]
			return h.li(
				[
					h.Key(key),
					...(isCurrent ? [h.AriaCurrent("true"), h.OnMount(CenterContextRow())] : []),
					h.Style({ "border-left-color": getSeverityColor(row.severityText) }),
					h.Class("border-b border-l-2 border-b-border/60 font-mono text-xs last:border-b-0"),
				],
				[
					isCurrent
						? h.div([h.Class(cn(ROW_CLASS, "bg-primary/8"))], cells)
						: h.button(
								[
									h.Type("button"),
									h.Class(
										cn(
											ROW_CLASS,
											"cursor-pointer text-left hover:bg-muted/50 focus-visible:bg-muted/70 focus-visible:outline-none",
										),
									),
									h.OnClick(Message.ClickedLog({ log: row })),
								],
								cells,
							),
				],
			)
		}),
	)
}

/** `LogContextPanel`: the logs around this one from its instance, or its whole service. */
export const contextPanel = (
	h: H,
	model: Model,
	log: LogRecord,
	timeZone: string,
	listClassName?: string,
): Html => {
	const instance = instanceAttribute(log)
	const scoped = scopedInstance(model, log)
	const rows = AsyncData.zipWith(model.contextBefore.data, model.contextAfter.data, (before, after) =>
		mergeLogContext(log, before, after),
	)
	return h.div(
		[h.Class("flex h-full min-h-0 flex-col gap-1.5")],
		[
			h.div(
				[h.Class("flex shrink-0 items-center gap-2")],
				[
					h.h4(
						[h.Class("text-xs font-medium text-muted-foreground")],
						[
							"Surrounding logs",
							h.span(
								[h.Class("ml-1 font-normal text-muted-foreground/60")],
								[scoped === undefined ? log.serviceName : `${scoped.key}=${scoped.value}`],
							),
						],
					),
					...(instance === undefined
						? []
						: [
								ToggleGroup.view(h, {
									model: model.contextScope,
									toParentMessage: (message) => Message.GotContextScopeMessage({ message }),
									items: [
										{ value: "instance", label: "Instance" },
										{ value: "service", label: "Service" },
									],
									variant: "outline",
									size: "xs",
									className: "ml-auto",
								}),
							]),
				],
			),
			Number.isNaN(timestampMs(log.timestamp))
				? emptyMessage(h, {}, ["This log has no readable timestamp"])
				: AsyncData.matchData(rows, {
						onEmpty: () => rowSkeleton(h, 8, ["w-16", "w-8"]),
						onFailure: (failure) =>
							errorState(h, {
								failure,
								title: "Couldn't load surrounding logs",
								variant: "inline",
							}),
						onData: (merged) => contextList(h, log, merged, timeZone, listClassName),
					}),
		],
	)
}

/** `formatTimelineOffset`: `+12.0ms` within the trace; negative is clock skew. */
const timelineOffset = (ms: number): string => (ms < 0 ? `−${formatDuration(-ms)}` : `+${formatDuration(ms)}`)

const isCurrentLog = (log: LogRecord, current: LogRecord): boolean =>
	log.timestamp === current.timestamp && log.spanId === current.spanId && log.body === current.body

const timelineRows = (h: H, model: Model, current: LogRecord, data: ReadonlyArray<LogRecord>): Html => {
	const logs = data.toSorted((a, b) => a.exactTimestamp.localeCompare(b.exactTimestamp))
	if (logs.length <= 1) return emptyMessage(h, {}, ["No other logs in this trace"])
	const spans = AsyncData.getData(model.traceSpans.data)
	const spanStart =
		spans._tag === "Some" && spans.value.traceStartTime !== null
			? new Date(spans.value.traceStartTime).getTime()
			: Number.NaN
	const hasSpanStart = Number.isFinite(spanStart)
	const traceStart = hasSpanStart ? spanStart : new Date(logs[0]?.timestamp ?? "").getTime()
	const spanNames = new Map(
		spans._tag === "Some" ? spans.value.spanNames.map((span) => [span.spanId, span.spanName]) : [],
	)
	return h.div(
		[h.Class("rounded-md border overflow-hidden")],
		logs.map((log, index) => {
			const isCurrent = isCurrentLog(log, current)
			const relativeMs = new Date(log.timestamp).getTime() - traceStart
			const previous = index > 0 ? logs[index - 1] : undefined
			const spanChanged =
				previous !== undefined && previous.spanId !== log.spanId ? log.spanId : undefined
			return h.div(
				[h.Key(`${log.timestamp}-${log.spanId}-${log.body.slice(0, 20)}-${index}`)],
				[
					...(spanChanged === undefined
						? []
						: [
								h.div(
									[h.Class("flex items-center gap-2 px-2 py-0.5 bg-muted/30")],
									[
										separator(h, "horizontal", "flex-1"),
										h.span(
											[
												h.Class(
													"text-4xs font-mono text-muted-foreground/60 shrink-0 truncate max-w-[200px]",
												),
											],
											[spanNames.get(spanChanged) ?? shortId(spanChanged, "span")],
										),
										separator(h, "horizontal", "flex-1"),
									],
								),
							]),
					h.div(
						[
							...(isCurrent
								? [h.OnMount(RevealTimelineRow())]
								: [h.OnClick(Message.ClickedLog({ log }))]),
							h.Style({ "border-left-color": getSeverityColor(log.severityText) }),
							h.Class(
								cn(
									"border-l-2 flex items-center gap-1.5 px-2 py-1 text-xs font-mono cursor-pointer border-b border-border last:border-b-0 hover:bg-muted/50 transition-colors",
									isCurrent && "bg-primary/8",
								),
							),
						],
						[
							h.span(
								[
									h.Class(
										cn(
											"text-3xs tabular-nums shrink-0 w-[56px] truncate text-right",
											relativeMs < 0 ? "text-severity-warn" : "text-muted-foreground",
										),
									),
									h.Title(
										hasSpanStart
											? "Offset from the trace start"
											: "Offset from the first log shown",
									),
								],
								[timelineOffset(relativeMs)],
							),
							...(log.serviceName === current.serviceName
								? []
								: [
										h.span(
											[
												h.Class(
													"flex max-w-[72px] shrink-0 items-center gap-1 truncate text-3xs text-muted-foreground/60",
												),
											],
											[
												serviceDot(h, { serviceName: log.serviceName, size: "sm" }),
												h.span([h.Class("truncate")], [log.serviceName]),
											],
										),
									]),
							h.span(
								[
									h.Class(
										cn(
											"min-w-0 flex-1 truncate text-2xs",
											isCurrent ? "text-foreground" : "text-foreground/80",
										),
									),
								],
								[log.body],
							),
						],
					),
				],
			)
		}),
	)
}

/** `LogTraceTimeline`: every log in this log's trace, with span boundaries. */
export const traceTimeline = (h: H, model: Model, log: LogRecord): Html | null => {
	if (log.traceId === undefined || log.traceId === "") return null
	const returned = AsyncData.getData(model.traceLogs.data)
	const count = returned._tag === "Some" ? returned.value.length : 0
	const isTruncated = count >= TRACE_LOG_LIMIT
	return h.div(
		[h.Class("space-y-1.5")],
		[
			h.h4(
				[h.Class("text-xs font-medium text-muted-foreground")],
				[
					"Trace Timeline",
					...(count > 1
						? [
								h.span(
									[
										h.Class("ml-1 text-muted-foreground/60"),
										...(isTruncated
											? [h.Title(`Showing the first ${TRACE_LOG_LIMIT} logs returned`)]
											: []),
									],
									[isTruncated ? `${TRACE_LOG_LIMIT}+` : String(count)],
								),
							]
						: []),
				],
			),
			AsyncData.matchData(model.traceLogs.data, {
				onEmpty: () => rowSkeleton(h, 5, ["w-10", "w-16"]),
				onFailure: (failure) =>
					errorState(h, { failure, title: "Couldn't load trace logs", variant: "inline" }),
				onData: (logs) => timelineRows(h, model, log, logs),
			}),
		],
	)
}
