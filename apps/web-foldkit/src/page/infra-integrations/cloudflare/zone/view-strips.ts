import { CLIENT_ERROR_NOTABLE } from "../../../../components/infra/cloudflare/list-model"
import {
	cacheHitRows,
	errorShareRows,
	latencyRows,
	requestRows,
	type ZoneSignalTotals,
	zoneSignalTotals,
} from "../../../../components/infra/cloudflare/zone-signals"
import { errorRateClass } from "@maple/ui/lib/error-rate"
import {
	EMPTY_VALUE,
	formatBytes,
	formatErrorRate,
	formatLatency,
	formatNumber,
	formatPercent,
} from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Chart from "../../../../charts/chart"
import * as InfraMetricChart from "../../../../charts/infra-metric-chart"
import type { ThemeColors } from "../../../../charts/theme-colors"
import { correlationStrips, type StripSeries } from "../../../infra/kit/correlation-strips"
import type { ZoneDetail, ZoneRow } from "../data"
import { MountLinkedCursor } from "./command"
import { Message, type Model } from "./model"

// `CloudflareZoneSignals`.

type H = HtmlBuilder<Message>

const summary = (
	h: H,
	value: string,
	caption?: string,
	valueClassName?: string,
	captionClassName?: string,
): ReadonlyArray<Html> => [
	h.span(
		[h.Class(cn("font-mono text-sm font-semibold tabular-nums text-foreground", valueClassName))],
		[value],
	),
	...(caption === undefined
		? []
		: [h.span([h.Class(cn("font-mono text-3xs text-muted-foreground", captionClassName))], [caption])]),
]

const buildStrips = (
	h: H,
	detail: ZoneDetail,
	zoneRow: ZoneRow | null,
	totals: ZoneSignalTotals,
): ReadonlyArray<StripSeries> => {
	const strips: ReadonlyArray<StripSeries> = [
		{
			id: "cf-requests",
			label: "Requests",
			source: "by status class",
			rows: requestRows(detail.statusBuckets),
			unit: "count",
			summary: summary(
				h,
				formatNumber(totals.requests),
				zoneRow === null ? undefined : `${formatBytes(zoneRow.bytes)} out`,
			),
		},
		{
			id: "cf-errors",
			label: "Errors",
			source: "4xx and 5xx share",
			rows: errorShareRows(detail.statusBuckets),
			unit: "percent",
			summary: summary(
				h,
				`${formatPercent(totals.clientErrorRate)} 4xx`,
				`5xx ${formatNumber(totals.serverErrors)} · ${formatErrorRate(totals.serverErrorRate)}`,
				totals.clientErrorRate >= CLIENT_ERROR_NOTABLE ? "text-severity-warn" : undefined,
				errorRateClass(totals.serverErrorRate, { neutral: "text-muted-foreground" }),
			),
		},
		{
			id: "cf-cache",
			label: "Cache hit",
			source: "of cacheable traffic",
			rows: cacheHitRows(detail.cacheBuckets),
			unit: "percent",
			summary: summary(
				h,
				totals.cacheHitRate === null ? EMPTY_VALUE : formatPercent(totals.cacheHitRate),
				totals.cacheHitRate === null
					? "nothing cacheable"
					: `${formatPercent(totals.cacheableShare)} is cacheable`,
			),
		},
	]
	// Only zones whose plan exposes timing quantiles get a latency strip.
	const latency = latencyRows(detail.latencyBuckets)
	return latency.length === 0
		? strips
		: [
				...strips,
				{
					id: "cf-latency",
					label: "Latency",
					source: "TTFB and origin p99",
					rows: latency,
					unit: "milliseconds",
					summary: summary(
						h,
						zoneRow === null ? EMPTY_VALUE : formatLatency(zoneRow.ttfbP99Ms),
						zoneRow === null ? undefined : `origin ${formatLatency(zoneRow.originP99Ms)}`,
					),
				},
			]
}

export const zoneSignals = (
	h: H,
	model: Model,
	options: Readonly<{
		detail: ZoneDetail
		zoneRow: ZoneRow | null
		isWaiting: boolean
		theme: ThemeColors
		timeZone: string
	}>,
): Html => {
	const { detail } = options
	const totals = zoneSignalTotals(detail.statusBuckets, detail.cacheBuckets)
	const strips = buildStrips(h, detail, options.zoneRow, totals).map((strip) =>
		(strip.id === "cf-latency" ? detail.latencyIgnoredFilters : detail.ignoredFilters).length > 0
			? { ...strip, source: `zone-wide, filters not applied · ${strip.source}` }
			: strip,
	)
	return correlationStrips(h, {
		strips,
		xDomain: [
			...new Set([...detail.statusBuckets, ...detail.cacheBuckets].map((b) => b.bucket)),
		].toSorted(),
		isWaiting: options.isWaiting,
		theme: options.theme,
		timeZone: options.timeZone,
		mountCursor: h.OnMount(MountLinkedCursor()),
		chart: (chartId, inputs) =>
			h.submodel({
				slotId: chartId,
				model: model.charts[chartId] ?? Chart.init(),
				view: InfraMetricChart.view,
				toParentMessage: (message: Chart.Message) => Message.GotChartMessage({ chartId, message }),
				viewInputs: { ...inputs, chartId },
			}),
	})
}
