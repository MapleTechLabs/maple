import { formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { spinner } from "@maple/web/ui/spinner"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "@maple/web/ui/table"
import { errorRateValue, latencyValue } from "@maple/web/ui/values"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { failureWithoutData, isPending } from "../../data/slot"
import { linkRow, rowLink } from "../kit/row-link"
import { errorState } from "../kit/view-states"
import { Message } from "./message"
import type { Model, OperationRow } from "./model"
import { tracesHref } from "./view-parts"

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
		tableCell(h, [formatNumber(op.estimatedSpanCount || op.spanCount)], "text-right tabular-nums"),
		tableCell(
			h,
			[formatNumber(op.estimatedErrorCount || op.errorCount)],
			cn("text-right tabular-nums", op.errorCount > 0 && "text-severity-error"),
		),
		tableCell(h, [errorRateValue(h, { rate: op.errorRate })], "text-right tabular-nums"),
		tableCell(h, [latencyValue(h, { ms: op.avgDurationMs, scale: "avg" })], "text-right"),
		tableCell(h, [latencyValue(h, { ms: op.p50DurationMs, scale: "p50" })], "text-right"),
		tableCell(h, [latencyValue(h, { ms: op.p95DurationMs, scale: "p95" })], "text-right"),
	])

const operationsBody = (h: HtmlBuilder<Message>, model: Model, range: string): Html => {
	if (isPending(model.operations))
		return h.div([h.Class("flex h-24 items-center justify-center rounded-md border")], [spinner(h)])
	const failure = failureWithoutData(model.operations)
	if (Option.isSome(failure))
		return errorState(h, {
			label: "operations",
			failure: failure.value,
			onRetry: Message.ClickedRetryOperations(),
		})
	const operations = Option.getOrElse(AsyncData.getData(model.operations.data), () => [])
	if (operations.length === 0)
		return h.div(
			[
				h.Class(
					"flex h-24 items-center justify-center rounded-md border text-sm text-muted-foreground",
				),
			],
			["No operations recorded in this range."],
		)
	return h.div(
		[h.Class("rounded-md border")],
		[
			table(h, {}, [
				tableHeader(h, [
					tableRow(h, [
						tableHead(h, ["Operation"]),
						...HEADERS.map((header) => tableHead(h, [header], "text-right")),
					]),
				]),
				tableBody(
					h,
					operations.map((op) => operationRow(h, model.serviceName, range, op)),
				),
			]),
		],
	)
}

export const topOperations = (h: HtmlBuilder<Message>, model: Model, range: string): Html =>
	h.section(
		[h.Class("space-y-2")],
		[h.h3([h.Class("text-sm font-medium")], ["Top operations"]), operationsBody(h, model, range)],
	)
