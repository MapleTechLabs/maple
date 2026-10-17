import { warehouseDateTimeToIso } from "@maple/query-engine"
import { formatDuration, formatNumber, pluralize } from "@maple/ui/lib/format"
import { shortId } from "@maple/ui/lib/ids"
import { formatRelativeTime } from "@maple/ui/lib/time-format"
import { cn } from "@maple/ui/lib/utils"
import { ROW_LANE } from "@maple/ui/styles/ui/list-row"
import { tableRowStyles } from "@maple/ui/styles/ui/table"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { httpSpanLabel } from "../../../ui/http-span-label"
import { truncatedText } from "../../../ui/truncated-text"
import { servicePills, traceStatusBadge } from "../../../ui/trace-badges"
import { button } from "../../../ui/button"
import { tableCell } from "../../../ui/table"
import { Message } from "./message"
import type { TraceRow } from "./model"

// One `TracesTableView` row (apps/web/src/components/traces/traces-table.tsx).

/** `formatTimestampInTimezone` (apps/web/src/lib/timezone-format.ts imports timezone atoms). */
export interface TimeFormat {
	readonly row: Intl.DateTimeFormat
	readonly withYear: Intl.DateTimeFormat
}

export const timeFormat = (timeZone: string): TimeFormat => {
	const options = {
		timeZone,
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	} as const
	return {
		row: new Intl.DateTimeFormat("en-US", options),
		withYear: new Intl.DateTimeFormat("en-US", { ...options, year: "numeric" }),
	}
}

const epochOf = (startTime: string): number => new Date(warehouseDateTimeToIso(startTime)).getTime()

/** `traceLink`: the trace page, with the row's own span pre-selected when it is not the root. */
export const traceHref = (row: TraceRow): string =>
	hrefOf(
		AppRoute.Trace({
			traceId: row.traceId,
			search: { t: row.startTime, spanId: row.isRootSpan ? undefined : row.spanId },
		}),
	)

const displayName = (row: TraceRow): string => {
	const name = row.rootName !== "" ? row.rootName : row.rootSpanName !== "" ? row.rootSpanName : "Unknown"
	const screenName = row.rootAttributes["screen.name"]
	return screenName !== undefined && screenName !== "" && !name.includes(screenName)
		? `${name} · ${screenName}`
		: name
}

const CELL = "p-2 whitespace-normal leading-normal"

const rootSpanCell = (h: HtmlBuilder<Message>, row: TraceRow, time: TimeFormat, nowMs: number): Html => {
	const epochMs = epochOf(row.startTime)
	const stamp = time.row.format(epochMs)
	const duration = formatDuration(row.durationMs)
	return tableCell(
		h,
		[
			h.div(
				[h.Class("flex flex-col min-w-0")],
				[
					// TODO(peek): legacy turns a plain click into the peek sheet; this link opens the page.
					h.a(
						[
							h.AriaLabel(`Open trace ${row.traceId}`),
							h.Attribute("class", "after:absolute after:inset-0 after:content-['']"),
							h.Href(traceHref(row)),
							h.Tabindex(-1),
						],
						[],
					),
					httpSpanLabel(h, {
						spanName: displayName(row),
						spanAttributes: row.rootAttributes,
						spanKind: row.rootKind,
						textClassName: "text-xs",
					}),
					truncatedText(h, { text: stamp, className: "text-3xs text-muted-foreground" }, [
						h.span([h.Class("hidden @min-[480px]/page:inline")], [stamp, " "]),
						h.span(
							[h.Class("text-muted-foreground/60")],
							[
								"(",
								h.time(
									[
										h.Attribute("class", ""),
										h.Attribute("datetime", new Date(epochMs).toISOString()),
										h.Title(time.withYear.format(epochMs)),
									],
									[formatRelativeTime(epochMs, nowMs)],
								),
								")",
							],
						),
						h.span([h.Class("@min-[480px]/page:hidden")], [" · ", duration]),
					]),
				],
			),
		],
		CELL,
	)
}

export const traceRow = (
	h: HtmlBuilder<Message>,
	row: TraceRow,
	index: number,
	time: TimeFormat,
	nowMs: number,
): Html =>
	h.tr(
		[
			h.Attribute(
				"class",
				cn(
					tableRowStyles,
					"hover:bg-muted/50 data-[focused]:bg-muted/70 data-[focused]:ring-1 data-[focused]:ring-ring data-[focused]:ring-inset cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
				),
			),
			h.DataAttribute("index", String(index)),
			h.DataAttribute("slot", "table-row"),
			h.Tabindex(0),
		],
		[
			tableCell(
				h,
				[
					h.a(
						[
							h.Attribute(
								"class",
								"relative z-10 font-mono text-xs text-primary underline decoration-primary/30 underline-offset-2 hover:decoration-primary",
							),
							h.Href(traceHref(row)),
						],
						[shortId(row.traceId, "trace")],
					),
				],
				cn(CELL, ROW_LANE, "before:bg-transparent"),
			),
			rootSpanCell(h, row, time, nowMs),
			tableCell(
				h,
				[servicePills(h, row.services) ?? ""],
				cn(CELL, "hidden @min-[680px]/page:table-cell"),
			),
			tableCell(
				h,
				[h.span([h.Class("font-mono text-xs text-muted-foreground")], [formatNumber(row.spanCount)])],
				cn(CELL, "hidden @min-[560px]/page:table-cell"),
			),
			tableCell(
				h,
				[h.span([h.Class("font-mono text-xs")], [formatDuration(row.durationMs)])],
				cn(CELL, "hidden @min-[480px]/page:table-cell"),
			),
			tableCell(
				h,
				[traceStatusBadge(h, { hasError: row.hasError, httpStatusCode: row.httpStatusCode })],
				CELL,
			),
		],
	)

/** The hidden-noise tally after the footer count, with the way back. */
export const noiseNote = (h: HtmlBuilder<Message>, hidden: number): Html =>
	h.span(
		[],
		[
			" · ",
			formatNumber(hidden),
			" single-span noise ",
			pluralize(hidden, "trace"),
			" hidden ",
			button(
				h,
				{
					variant: "link",
					size: "xs",
					className:
						"h-auto p-0 text-primary underline decoration-primary/30 hover:decoration-primary",
					attributes: [h.OnClick(Message.ClickedShowNoise())],
				},
				["show"],
			),
		],
	)
