import { warehouseDateTimeToIso } from "@maple/query-engine"
import { formatDuration, formatNumber, pluralize } from "@maple/ui/lib/format"
import { shortId } from "@maple/ui/lib/ids"
import { formatTimestampInTimezone } from "@maple/web-data/lib/timezone-format"
import { cn } from "@maple/ui/lib/utils"
import { Option } from "effect"
import { traceHrefFrom } from "./peek"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { TracesSearch } from "../../../route/search"

type Search = typeof TracesSearch.Type
import { httpSpanLabel } from "../../../ui/http-span-label"
import { truncatedText } from "../../../ui/truncated-text"
import { servicePills, traceStatusBadge } from "../../../ui/trace-badges"
import { button } from "../../../ui/button"
import { laneTableCell, rowLink, tableCell, tableRow } from "../../../ui/table"
import { latencyValue } from "../../../ui/values"
import { listRelativeTime } from "../../kit/relative-time"
import { Message } from "./message"
import type { TraceRow } from "./model"

// One row of the traces table.

const epochOf = (startTime: string): number => new Date(warehouseDateTimeToIso(startTime)).getTime()

/** `traceLink`: the trace page, with the row's own span pre-selected when it is not the root. */
/** `traceLink`: the trace page, keeping the list's search (`{ ...prev, t, spanId }`). */
export const traceHref = (search: Search, row: TraceRow): string =>
	traceHrefFrom(search, row.traceId, row.startTime, row.isRootSpan ? undefined : row.spanId)

const displayName = (row: TraceRow): string => {
	const name = row.rootName !== "" ? row.rootName : row.rootSpanName !== "" ? row.rootSpanName : "Unknown"
	const screenName = row.rootAttributes["screen.name"]
	return screenName !== undefined && screenName !== "" && !name.includes(screenName)
		? `${name} · ${screenName}`
		: name
}

const CELL = "p-2 whitespace-normal leading-normal"

const rootSpanCell = (
	h: HtmlBuilder<Message>,
	row: TraceRow,
	index: number,
	timeZone: string,
	nowMs: number,
	search: Search,
): Html => {
	const epochMs = epochOf(row.startTime)
	const stamp = formatTimestampInTimezone(epochMs, { timeZone })
	const duration = formatDuration(row.durationMs)
	return tableCell(
		h,
		[
			h.div(
				[h.Class("flex flex-col min-w-0")],
				[
					// A plain click peeks (`MountPeekRows`); modified, middle and right clicks follow the link.
					rowLink(h, {
						href: traceHref(search, row),
						label: `Open trace ${row.traceId}`,
						attributes: [h.DataAttribute("peek-index", String(index)), h.Tabindex(-1)],
					}),
					httpSpanLabel(h, {
						spanName: displayName(row),
						spanAttributes: row.rootAttributes,
						spanKind: row.rootKind,
						textClassName: "text-xs",
					}),
					truncatedText(h, { text: stamp, className: "text-3xs text-muted-foreground" }, [
						h.span([h.Class("hidden @min-[480px]/page:inline")], [stamp, " "]),
						h.span(
							[h.Class("text-foreground-subtle")],
							[
								"(",
								listRelativeTime(h, { value: epochMs, nowMs, timeZone }),
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

export type RowState = Readonly<{ search: Search; isFocused: boolean; isActive: boolean; isMobile: boolean }>

export const traceRow = (
	h: HtmlBuilder<Message>,
	row: TraceRow,
	index: number,
	timeZone: string,
	nowMs: number,
	state: RowState,
): Html =>
	tableRow(
		h,
		[
			laneTableCell(
				h,
				state.isActive,
				[
					h.a(
						[
							h.Attribute(
								"class",
								"relative z-10 font-mono text-xs text-primary underline decoration-primary-a3 underline-offset-2 hover:decoration-primary active:decoration-primary",
							),
							h.Href(traceHref(state.search, row)),
						],
						[shortId(row.traceId, "trace")],
					),
				],
				CELL,
			),
			rootSpanCell(h, row, index, timeZone, nowMs, state.search),
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
				[latencyValue(h, { ms: row.durationMs, className: "text-xs" })],
				cn(CELL, "hidden @min-[480px]/page:table-cell"),
			),
			tableCell(
				h,
				[traceStatusBadge(h, { hasError: row.hasError, httpStatusCode: row.httpStatusCode })],
				CELL,
			),
		],
		cn(
			state.isActive && "bg-surface-strong",
			"hover:bg-surface-sunken active:bg-surface-sunken data-[focused]:bg-surface-strong data-[focused]:ring-1 data-[focused]:ring-ring data-[focused]:ring-inset cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
		),
		[
			// Keyed by index so a scrolled-in row is a new node the virtualizer measures.
			h.Key(`row-${index}`),
			...(state.isFocused ? [h.DataAttribute("focused", "true")] : []),
			h.DataAttribute("index", String(index)),
			h.Tabindex(0),
			h.OnKeyDownPreventDefault((key) =>
				key === "Enter" || key === " "
					? Option.some(
							state.isMobile
								? Message.PressedOpenRow({ index })
								: Message.ClickedPeekRow({ index }),
						)
					: Option.none(),
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
						"h-auto p-0 text-primary underline decoration-primary-a3 hover:decoration-primary active:decoration-primary",
					attributes: [h.OnClick(Message.ClickedShowNoise())],
				},
				["show"],
			),
		],
	)
