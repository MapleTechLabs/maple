import { formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "@maple/web/ui/table"
import { tableSkeleton } from "@maple/web/ui/table-skeleton"
import { errorRateValue, latencyValue, serviceDot } from "@maple/web/ui/values"
import type { Html } from "foldkit/html"
import { hrefFor } from "../../route"
import { linkRow, rowLink } from "../kit/row-link"
import type { ServicesViewBuilder } from "./composition"
import type { ServiceCatalogEntry } from "./model"

// The table of `ServicesListView` and its `ServiceRow`.

const NUMBER_COLUMNS = ["Spans", "Errors", "Error rate", "p50", "p95", "Logs"]

export const servicesSkeleton = (h: ServicesViewBuilder): Html =>
	h.div(
		[h.Class("p-4")],
		[
			tableSkeleton(h, {
				rows: 8,
				columns: [
					{ header: "Service", skeleton: "w-40" },
					...NUMBER_COLUMNS.map((header) => ({ header, headClassName: "text-right", skeleton: "ml-auto w-12" })),
				],
			}),
		],
	)

const serviceRow = (h: ServicesViewBuilder, entry: ServiceCatalogEntry, query: URLSearchParams): Html =>
	linkRow(h, undefined, [
		tableCell(h, [
			rowLink(h, { href: hrefFor(`/services/${encodeURIComponent(entry.serviceName)}`, query), className: "flex items-center gap-2" }, [
				serviceDot(h, { serviceName: entry.serviceName }),
				h.span([h.Class("font-medium")], [entry.serviceName]),
				...(entry.serviceNamespaces.length > 0
					? [h.span([h.Class("truncate text-xs text-muted-foreground")], [entry.serviceNamespaces.join(", ")])]
					: []),
			]),
		]),
		tableCell(h, [formatNumber(entry.spanCount)], "text-right tabular-nums"),
		tableCell(h, [formatNumber(entry.errorCount)], cn("text-right tabular-nums", entry.errorCount > 0 && "text-severity-error")),
		tableCell(h, [errorRateValue(h, { rate: entry.errorRate })], "text-right"),
		tableCell(h, [latencyValue(h, { ms: entry.p50LatencyMs, scale: "p50" })], "text-right"),
		tableCell(h, [latencyValue(h, { ms: entry.p95LatencyMs, scale: "p95" })], "text-right"),
		tableCell(h, [formatNumber(entry.logCount)], "text-right tabular-nums"),
	])

export const servicesTable = (
	h: ServicesViewBuilder,
	entries: ReadonlyArray<ServiceCatalogEntry>,
	query: URLSearchParams,
	isPlaceholder: boolean,
): Html =>
	h.div(
		[h.Class(cn("p-4", isPlaceholder && "opacity-60 transition-opacity"))],
		[
			h.div(
				[h.Class("rounded-md border")],
				[
					table(h, {}, [
						tableHeader(h, [
							tableRow(h, [tableHead(h, ["Service"]), ...NUMBER_COLUMNS.map((header) => tableHead(h, [header], "text-right"))]),
						]),
						tableBody(h, entries.map((entry) => serviceRow(h, entry, query))),
					]),
				],
			),
		],
	)
