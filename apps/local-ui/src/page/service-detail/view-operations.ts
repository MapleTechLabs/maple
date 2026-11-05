import { formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { errorState } from "@maple/views/ui/error-state"
import { spinner } from "@maple/views/ui/spinner"
import {
	table,
	tableBody,
	numericTableCell,
	tableCell,
	tableHead,
	tableHeader,
	tableRow,
} from "@maple/views/ui/table"
import { errorRateValue, latencyValue } from "@maple/views/ui/values"
import { Option, Array as Arr } from "effect"
import { AsyncData } from "foldkit"
import { heading } from "@maple/views/ui/heading"
import type { Html, HtmlBuilder } from "foldkit/html"
import { failureWithoutData, isAwaitingFirstData } from "@maple/views/data/keyed"
import { linkRow, rowLink } from "../kit/row-link"
import { Message } from "./message"
import type { Model, OperationRow } from "./model"
import { tracesHref } from "./view-parts"
import { hstack } from "@maple/views/ui/stack"
import { typographyClass } from "@maple/views/ui/typography"
import { nonZeroOr } from "@maple/ui/lib/number"

// The "Top operations" section of `ServiceDetailView`.

const HEADERS = ["Spans", "Errors", "Error rate", "Avg", "p50", "p95"]

const operationRow = (h: HtmlBuilder<Message>, serviceName: string, range: string, op: OperationRow): Html =>
	linkRow(h, undefined, [
		tableCell(
			h,
			[
				rowLink(
					h,
					{
						href: tracesHref(serviceName, range, op.spanName),
						label: `Traces with ${op.spanName}`,
					},
					[op.spanName],
				),
			],
			"max-w-96 truncate font-mono text-xs",
		),
		numericTableCell(h, [formatNumber(nonZeroOr(op.estimatedSpanCount, op.spanCount))]),
		numericTableCell(
			h,
			[formatNumber(nonZeroOr(op.estimatedErrorCount, op.errorCount))],
			cn(op.errorCount > 0 && "text-severity-error"),
		),
		numericTableCell(h, [errorRateValue(h, { rate: op.errorRate })]),
		tableCell(h, [latencyValue(h, { ms: op.avgDurationMs, scale: "avg" })], "text-right"),
		tableCell(h, [latencyValue(h, { ms: op.p50DurationMs, scale: "p50" })], "text-right"),
		tableCell(h, [latencyValue(h, { ms: op.p95DurationMs, scale: "p95" })], "text-right"),
	])

const operationsBody = (h: HtmlBuilder<Message>, model: Model, range: string): Html => {
	if (isAwaitingFirstData(model.operations))
		return h.div([h.Class("flex h-24 items-center justify-center rounded-md border")], [spinner(h)])
	const failure = failureWithoutData(model.operations)
	if (Option.isSome(failure))
		return errorState(h, {
			failure: failure.value,
			title: "Couldn’t load operations",
			onRetry: Message.ClickedRetryOperations(),
		})
	const operations = Option.getOrElse(AsyncData.getData(model.operations.data), () => [])
	if (operations.length === 0)
		return hstack(
			h,
			{
				justify: "center",
				className: cn("h-24 rounded-md border", typographyClass({ size: "sm", tone: "muted" })),
			},
			["No operations recorded in this range."],
		)
	return h.div(
		[h.Class("rounded-md border")],
		[
			table(h, {}, [
				tableHeader(h, [
					tableRow(h, [
						tableHead(h, ["Operation"]),
						...Arr.map(HEADERS, (header) => tableHead(h, [header], "text-right")),
					]),
				]),
				tableBody(
					h,
					Arr.map(operations, (op) => operationRow(h, model.serviceName, range, op)),
				),
			]),
		],
	)
}

export const topOperations = (h: HtmlBuilder<Message>, model: Model, range: string): Html =>
	h.section(
		[h.Class("space-y-2")],
		[
			heading(h, { level: 3, variant: "subsection" }, ["Top operations"]),
			operationsBody(h, model, range),
		],
	)
