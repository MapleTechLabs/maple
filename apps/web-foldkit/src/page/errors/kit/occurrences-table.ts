import type { ErrorIssueSampleTrace } from "@maple/domain/http"
import { cn } from "@maple/ui/lib/utils"
import { truncatedCellStyles } from "@maple/ui/styles/ui/table"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { empty, emptyDescription, emptyHeader, emptyTitle } from "../../../ui/empty"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "../../../ui/table"
import { truncatedId } from "../../../ui/truncated-id"
import { truncatedText } from "../../../ui/truncated-text"
import { serviceDot } from "../../../ui/values"
import { relativeTime } from "../../kit/relative-time"

// The issue occurrences table.

export type OccurrencesTableInputs = Readonly<{ nowMs: number; timeZone: string }>

const TRACE_PILL = cn(
	"inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-2 py-0.5",
	"font-mono text-2xs text-muted-foreground tabular-nums",
	"transition-colors hover:border-primary/40 hover:bg-primary/10 hover:text-primary",
)

const occurrenceRow = <M>(
	h: HtmlBuilder<M>,
	trace: ErrorIssueSampleTrace,
	inputs: OccurrencesTableInputs,
): Html =>
	tableRow(
		h,
		[
			tableCell(
				h,
				[
					relativeTime(h, {
						value: trace.timestamp,
						nowMs: inputs.nowMs,
						timeZone: inputs.timeZone,
						tooltip: "title",
					}),
				],
				"tabular-nums text-muted-foreground",
			),
			tableCell(h, [
				h.span(
					[h.Class("inline-flex items-center gap-1.5")],
					[
						serviceDot(h, { serviceName: trace.serviceName, size: "sm" }),
						h.span([], [trace.serviceName]),
					],
				),
			]),
			tableCell(
				h,
				[
					truncatedText(h, { text: trace.exceptionMessage }, [
						trace.exceptionMessage.split("\n", 1)[0] ?? "",
					]),
				],
				truncatedCellStyles,
			),
			tableCell(h, [
				h.a(
					[
						h.Href(
							hrefOf(
								AppRoute.Trace({ traceId: trace.traceId, search: { t: trace.timestamp } }),
							),
						),
						h.Class(TRACE_PILL),
					],
					[truncatedId(h, { value: trace.traceId, length: 12, ellipsis: true })],
				),
			]),
		],
		undefined,
		[h.Key(`${trace.traceId}-${trace.spanId}`)],
	)

/** The sampled traces of an issue, newest first as the server sends them, each linking its trace. */
export const occurrencesTable = <M>(
	h: HtmlBuilder<M>,
	traces: ReadonlyArray<ErrorIssueSampleTrace>,
	inputs: OccurrencesTableInputs,
): Html =>
	traces.length === 0
		? empty(h, [
				emptyHeader(h, [
					emptyTitle(h, ["No samples in this window"]),
					emptyDescription(h, [
						"This fingerprint was not seen in the selected range. Widen the time range to find traces to open.",
					]),
				]),
			])
		: table(h, {}, [
				tableHeader(h, [
					tableRow(h, [
						tableHead(h, ["Time"]),
						tableHead(h, ["Service"]),
						tableHead(h, ["Message"]),
						tableHead(h, ["Trace"]),
					]),
				]),
				tableBody(
					h,
					traces.map((trace) => occurrenceRow(h, trace, inputs)),
				),
			])
