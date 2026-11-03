import { formatNumber } from "@maple/ui/lib/format"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { cn } from "@maple/ui/lib/utils"
import {
	table,
	tableBody,
	numericTableCell,
	tableCell,
	tableHead,
	tableHeader,
	tableRow,
} from "@maple/views/ui/table"
import { tableSkeleton } from "@maple/views/ui/table-skeleton"
import { errorRateValue, latencyValue, serviceDot } from "@maple/views/ui/values"
import type { Html, HtmlBuilder } from "foldkit/html"
import { hrefFor } from "../../route"
import { linkRow, rowLink } from "../kit/row-link"
import type { Message } from "./message"
import type { ServiceCatalogEntry } from "./model"
import { hstackClass } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"

// The table of `ServicesListView` and its `ServiceRow`.

const NUMBER_COLUMNS = ["Spans", "Errors", "Error rate", "p50", "p95", "Logs"]

export const servicesSkeleton = (h: HtmlBuilder<Message>): Html =>
	h.div(
		[h.Class("p-4")],
		[
			tableSkeleton(h, {
				rows: 8,
				columns: [
					{ header: "Service", skeleton: "w-40" },
					...NUMBER_COLUMNS.map((header) => ({
						header,
						headClassName: "text-right",
						skeleton: "ml-auto w-12",
					})),
				],
			}),
		],
	)

const serviceRow = (h: HtmlBuilder<Message>, entry: ServiceCatalogEntry, query: URLSearchParams): Html =>
	linkRow(h, undefined, [
		tableCell(h, [
			rowLink(
				h,
				{
					href: hrefFor(`/services/${encodeURIComponent(entry.serviceName)}`, query),
					className: hstackClass({ gap: "2" }),
				},
				[
					serviceDot(h, { serviceName: entry.serviceName }),
					typography(h, { weight: "medium" }, [entry.serviceName]),
					...(entry.serviceNamespaces.length > 0
						? [
								typography(h, { size: "xs", tone: "muted", truncate: true }, [
									entry.serviceNamespaces.join(", "),
								]),
							]
						: []),
				],
			),
		]),
		numericTableCell(h, [formatNumber(entry.spanCount)]),
		numericTableCell(
			h,
			[formatNumber(entry.errorCount)],
			cn(entry.errorCount > 0 && "text-severity-error"),
		),
		tableCell(h, [errorRateValue(h, { rate: entry.errorRate })], "text-right"),
		tableCell(h, [latencyValue(h, { ms: entry.p50LatencyMs, scale: "p50" })], "text-right"),
		tableCell(h, [latencyValue(h, { ms: entry.p95LatencyMs, scale: "p95" })], "text-right"),
		numericTableCell(h, [formatNumber(entry.logCount)]),
	])

export const servicesTable = (
	h: HtmlBuilder<Message>,
	entries: ReadonlyArray<ServiceCatalogEntry>,
	query: URLSearchParams,
	isPlaceholder: boolean,
): Html =>
	h.div(
		[h.Class(cn("p-4", refreshingClass(isPlaceholder)))],
		[
			h.div(
				[h.Class("rounded-md border")],
				[
					table(h, {}, [
						tableHeader(h, [
							tableRow(h, [
								tableHead(h, ["Service"]),
								...NUMBER_COLUMNS.map((header) => tableHead(h, [header], "text-right")),
							]),
						]),
						tableBody(
							h,
							entries.map((entry) => serviceRow(h, entry, query)),
						),
					]),
				],
			),
		],
	)
