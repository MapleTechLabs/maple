import { formatUtcTitle } from "../../lib/time"
import { formatDateTime, type TimeFormat } from "../kit/local-time"
import { EMPTY_VALUE, formatDuration, formatNumber } from "@maple/ui/lib/format"
import { getHttpInfo } from "@maple/ui/lib/http"
import { formatRelativeFrom } from "@maple/ui/lib/time-format"
import { cn } from "@maple/ui/lib/utils"
import { httpSpanLabel } from "@maple/web/ui/http-span-label"
import { tableCell } from "@maple/web/ui/table"
import { servicePills, traceStatusBadge } from "@maple/web/ui/trace-badges"
import { DateTime } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { hrefFor } from "../../route"
import { linkRow, rowLink } from "../kit/row-link"
import type { Message } from "./message"
import type { TraceRow } from "./model"

// One row of the traces list.

export const traceRow = (
	h: HtmlBuilder<Message>,
	row: TraceRow,
	query: URLSearchParams,
	nowMs: number,
	timeFormat: TimeFormat,
): Html => {
	const href = hrefFor(`/traces/${encodeURIComponent(row.traceId)}`, query)
	const httpStatusCode = getHttpInfo({
		spanName: row.rootSpanName,
		spanKind: row.rootSpanKind,
		spanAttributes: { ...row.rootSpanAttributes },
	})?.statusCode
	const pills = servicePills(h, row.services)
	return linkRow(h, cn(row.hasError && "bg-severity-error/5"), [
		tableCell(
			h,
			[
				rowLink(
					h,
					{
						href,
						label: `Trace ${row.rootSpanName || row.traceId}`,
						className: "flex items-center gap-2",
					},
					[
						...(row.hasError
							? [
									h.span(
										[h.Class("size-1.5 shrink-0 rounded-full bg-severity-error")],
										[h.span([h.Class("sr-only")], ["Errored"])],
									),
								]
							: []),
						httpSpanLabel(h, {
							spanName: row.rootSpanName,
							spanKind: row.rootSpanKind,
							spanAttributes: row.rootSpanAttributes,
							className: "min-w-0",
							textClassName: "text-xs",
						}),
					],
				),
			],
			"min-w-0",
		),
		tableCell(h, pills === null ? [] : [pills]),
		tableCell(h, [formatDuration(row.durationMs)], "text-right font-mono tabular-nums"),
		tableCell(
			h,
			[row.spanCount === null ? EMPTY_VALUE : formatNumber(row.spanCount)],
			"text-right font-mono tabular-nums text-muted-foreground",
		),
		tableCell(h, [traceStatusBadge(h, { hasError: row.hasError, httpStatusCode })]),
		tableCell(
			h,
			[formatRelativeFrom(DateTime.toEpochMillis(row.startTime), nowMs)],
			"text-right text-xs whitespace-nowrap text-muted-foreground",
			[h.Title(`${formatDateTime(timeFormat, row.startTime)} (${formatUtcTitle(row.startTime)})`)],
		),
	])
}
