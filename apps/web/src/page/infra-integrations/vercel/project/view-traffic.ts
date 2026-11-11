import type {
	VercelInfraBreakdownRow,
	VercelInfraLatencyBucket,
	VercelInfraProjectDetailResponse,
	VercelInfraRequestBucket,
} from "@maple/domain/http"
import { formatWarehouseDateTime } from "@maple/query-engine"
import { errorRateClass } from "@maple/ui/lib/error-rate"
import {
	EMPTY_VALUE,
	formatBytes,
	formatErrorRate,
	formatLatency,
	formatNumber,
	formatPercent,
} from "@maple/ui/lib/format"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { Array as Arr, Order } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Chart from "@maple/views/charts/chart"
import * as InfraMetricChart from "@maple/views/charts/infra-metric-chart"
import type { ThemeColors } from "@maple/views/charts/theme-colors"
import { STATUS_CLASS_COLORS } from "@maple/views/lib/cloudflare-constants"
import { alert, alertAction, alertDescription, alertTitle } from "@maple/views/ui/alert"
import { linkButton } from "@maple/views/ui/button"
import { badge } from "@maple/views/ui/display"
import { errorState } from "@maple/views/ui/error-state"
import { filterChip } from "@maple/views/ui/filter-chip"
import { icon } from "@maple/views/ui/icon"
import { listFooter } from "@maple/views/ui/list-footer"
import { backdropBar } from "@maple/views/ui/meter"
import { panel, panelHeader, panelTitle } from "@maple/views/ui/panel"
import { removableChip } from "@maple/views/ui/removable-chip"
import { segmentedSelect } from "@maple/views/ui/segmented-select"
import { skeleton } from "@maple/views/ui/skeleton"
import { hstack, vstack } from "@maple/views/ui/stack"
import { textLink } from "@maple/views/ui/text-link"
import { typography, typographyClass, type TypographyTone } from "@maple/views/ui/typography"
import { deployedAt, deployLabel, type DeployRegression } from "../deploy-signals"
import { requestClassRows, vercelProjectLogAttrs, vercelProjectTracesWhere } from "../list-model"
import {
	cacheHitRows,
	coldStartRows,
	type DeploySignals,
	latencyRows,
	projectTotals,
	serverErrorRateRows,
} from "../project-signals"
import { AppRoute, hrefOf } from "../../../../route"
import { VercelBreakdownBy } from "../../../../route/search"
import { correlationStrips, type StripSeries } from "../../../infra/kit/correlation-strips"
import { columnHead, dataTable, dataTableEmpty, NUMERIC_CELL } from "../../../kit/data-table"
import type { TimeSearch } from "../../../kit/view-tabs"
import { relativeTime } from "../../../kit/relative-time"
import { sectionHeading } from "../../../kit/section-heading"
import { type Clock, LEAD_COLUMN, ROW_CLASS } from "../view-parts"
import { MountLinkedCursor } from "./command"
import { Message, type Model } from "./model"
import { breakdownByOf } from "./update"

// The traffic tab: the deploy-regression callout, the linked strips, the breakdown and the top
// error logs.

type H = HtmlBuilder<Message>

// Strips

const summary = (
	h: H,
	value: string,
	caption: string,
	tones: Readonly<{ value?: TypographyTone; caption?: TypographyTone }> = {},
): ReadonlyArray<Html> => [
	typography(
		h,
		{ size: "sm", tone: tones.value ?? "foreground", weight: "semibold", mono: true, numeric: true },
		[value],
	),
	typography(h, { size: "3xs", tone: tones.caption ?? "muted", mono: true }, [caption]),
]

const rateText = (rate: number | null, format: (rate: number) => string) =>
	rate === null ? EMPTY_VALUE : format(rate)

const strips = (
	h: H,
	buckets: ReadonlyArray<VercelInfraRequestBucket>,
	latency: ReadonlyArray<VercelInfraLatencyBucket> | null,
	regression: DeployRegression | null,
	edgeP95Ms: number | null,
): ReadonlyArray<StripSeries> => {
	const totals = projectTotals(buckets, latency ?? [])
	const failing = totals.serverErrorRate !== null && totals.serverErrorRate >= 0.01
	const requests: ReadonlyArray<StripSeries> = [
		{
			id: "vercel-requests",
			label: "Requests",
			source: "log drain · by status",
			rows: requestClassRows(buckets),
			unit: "count",
			stacked: true,
			colors: STATUS_CLASS_COLORS,
			summary: summary(h, formatNumber(totals.requests), "in this window"),
		},
		{
			id: "vercel-5xx",
			label: "5xx rate",
			source: "log drain · status ≥ 500",
			rows: serverErrorRateRows(buckets),
			unit: "percent",
			colors: { value: "--severity-error" },
			summary: summary(
				h,
				rateText(totals.serverErrorRate, formatErrorRate),
				regression === null
					? `${formatNumber(totals.requests5xx)} server errors`
					: `peak ${formatErrorRate(regression.peakRate)} after ${deployLabel(regression.deployment)}`,
				{ value: failing ? "error" : "foreground", caption: regression === null ? "muted" : "error" },
			),
		},
		{
			id: "vercel-cache",
			label: "Cache hit",
			source: "x-vercel-cache",
			rows: cacheHitRows(buckets),
			unit: "percent",
			summary: summary(
				h,
				rateText(totals.cacheHitRate, formatPercent),
				totals.cacheLookups === 0
					? "no cache lookups"
					: `of ${formatNumber(totals.cacheLookups)} lookups`,
			),
		},
	]
	if (latency === null) return requests
	return [
		...requests,
		{
			id: "vercel-latency",
			label: "Latency p95",
			source: "edge and Invoke Function",
			rows: latencyRows(latency),
			unit: "milliseconds",
			summary: summary(
				h,
				edgeP95Ms === null ? EMPTY_VALUE : formatLatency(edgeP95Ms),
				"edge, whole window",
			),
		},
		{
			id: "vercel-cold",
			label: "Cold starts",
			source: "Start VM and Init User Code",
			rows: coldStartRows(latency),
			unit: "percent",
			summary: summary(
				h,
				rateText(totals.coldStartRate, formatPercent),
				`of ${formatNumber(totals.invocations)} invocations`,
			),
		},
	]
}

export const signals = (
	h: H,
	model: Model,
	options: Readonly<{
		buckets: ReadonlyArray<VercelInfraRequestBucket>
		/** Null when the trace drain is off: no latency or cold-start strips. */
		latency: ReadonlyArray<VercelInfraLatencyBucket> | null
		deploys: DeploySignals
		edgeP95Ms: number | null
		isWaiting: boolean
		theme: ThemeColors
		timeZone: string
	}>,
): Html =>
	correlationStrips(h, {
		strips: strips(
			h,
			options.buckets,
			options.latency,
			options.deploys.regressions[options.deploys.regressions.length - 1] ?? null,
			options.edgeP95Ms,
		),
		xDomain: Arr.map(options.buckets, (bucket) => bucket.bucket),
		markers: options.deploys.markers,
		deploys: {
			markers: options.deploys.commits,
			plotOf: (chartId) => (model.charts[chartId] ?? Chart.init()).plot,
		},
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

export const signalsLoading = (h: H): Html => skeleton(h, "h-96 w-full")

// Regression callout

const figure = (h: H, value: string, caption: string, tone: TypographyTone): Html =>
	vstack(h, { gap: "0.5", align: "end" }, [
		typography(h, { size: "sm", tone, weight: "semibold", mono: true, numeric: true }, [value]),
		typography(h, { size: "3xs", tone: "muted", mono: true }, [caption]),
	])

/** `VercelRegressionCallout`: a production deploy the 5xx rate jumped after, and whether it recovered. */
export const regressionCallout = (h: H, regression: DeployRegression, projectId: string): Html => {
	const { deployment, resolvedBy } = regression
	const label = deployLabel(deployment)
	return alert(h, { variant: "crit" }, [
		icon(h, "CircleWarningIcon"),
		alertTitle(h, [
			`5xx rose to ${formatErrorRate(regression.peakRate)} after ${label}`,
			resolvedBy === null ? " and is still elevated" : ` and recovered with ${deployLabel(resolvedBy)}`,
		]),
		alertDescription(h, [
			Arr.join(
				[
					`${formatNumber(regression.failedRequests)} failed requests`,
					...(deployment.commitMessage === null ? [] : [`"${deployment.commitMessage}"`]),
				],
				" · ",
			),
		]),
		alertAction(
			h,
			[
				figure(h, formatErrorRate(regression.beforeRate), "before", "foreground"),
				figure(h, formatErrorRate(regression.peakRate), label, "error"),
				linkButton(
					h,
					{
						size: "sm",
						variant: "outline",
						href: hrefOf(
							AppRoute.Traces({
								search: {
									startTime: formatWarehouseDateTime(deployedAt(deployment)),
									endTime: formatWarehouseDateTime(regression.endsAtMs),
									whereClause: vercelProjectTracesWhere(projectId),
								},
							}),
						),
					},
					["Open traces"],
				),
			],
			"items-center gap-4",
		),
	])
}

// Breakdown

type Dimension = Readonly<{ tab: string; column: string; noun: string }>

const DIMENSIONS = {
	path: { tab: "Paths", column: "Path", noun: "paths" },
	host: { tab: "Hosts", column: "Host", noun: "hosts" },
	region: { tab: "Regions", column: "Region", noun: "regions" },
	source: { tab: "Source", column: "Source", noun: "sources" },
	cache: { tab: "Cache", column: "Cache status", noun: "cache statuses" },
	waf: { tab: "WAF", column: "WAF action", noun: "WAF actions" },
	status: { tab: "Status", column: "Status", noun: "status codes" },
} satisfies Record<VercelBreakdownBy, Dimension>

const BREAKDOWN_ROWS = 10

const breakdownRow = (h: H, row: VercelInfraBreakdownRow, total: number, hasBytes: boolean): Html => {
	const errorRate = row.requests > 0 ? row.requests5xx / row.requests : 0
	return h.div(
		[h.Key(row.key), h.Class(cn(ROW_CLASS, "relative"))],
		[
			backdropBar(h, { value: row.requests, max: total, className: "bg-primary-a2" }),
			typography(
				h,
				{
					size: "xs",
					tone: row.key === "" ? "muted" : "foreground",
					mono: true,
					truncate: true,
					className: cn(LEAD_COLUMN, "relative"),
					attributes: [h.Title(row.key)],
				},
				[row.key === "" ? "(none)" : row.key],
			),
			h.span(
				[
					h.Class(cn(NUMERIC_CELL, "relative w-24 text-foreground-soft")),
					h.Title(`${formatPercent(total > 0 ? row.requests / total : 0)} of listed requests`),
				],
				[formatNumber(row.requests)],
			),
			h.span(
				[h.Class(cn(NUMERIC_CELL, "relative w-20 text-foreground-soft"))],
				[formatNumber(row.requests5xx)],
			),
			h.span(
				[h.Class(cn(NUMERIC_CELL, "relative w-20", errorRateClass(errorRate)))],
				[formatErrorRate(errorRate)],
			),
			h.span(
				[h.Class(cn(NUMERIC_CELL, "relative hidden w-20 text-foreground-soft md:block"))],
				[row.cacheLookups === 0 ? EMPTY_VALUE : formatPercent(row.cacheHits / row.cacheLookups)],
			),
			...(hasBytes
				? [
						h.span(
							[h.Class(cn(NUMERIC_CELL, "relative hidden w-24 text-foreground-soft md:block"))],
							[formatBytes(row.bytes)],
						),
					]
				: []),
		],
	)
}

const breakdownTable = (
	h: H,
	dimension: Dimension,
	rows: ReadonlyArray<VercelInfraBreakdownRow>,
	isWaiting: boolean,
): ReadonlyArray<Html> => {
	const sorted = Arr.sort(
		rows,
		Order.mapInput(Order.flip(Order.Number), (row: VercelInfraBreakdownRow) => row.requests),
	)
	const shown = Arr.take(sorted, BREAKDOWN_ROWS)
	const total = Arr.reduce(rows, 0, (sum, row) => sum + row.requests)
	// Vercel sends a response size only on some plans and runtimes; a column of zeros says nothing.
	const hasBytes = Arr.some(rows, (row) => row.bytes > 0)
	const footer = listFooter(h, {
		shown: shown.length,
		total: rows.length,
		noun: dimension.noun,
		align: "start",
		className: "gap-x-1 px-4 py-2",
		children: [typography(h, { size: "3xs", tone: "muted", mono: true }, ["from the log drain"])],
	})
	return [
		dataTable(
			h,
			{ ariaLabel: `Requests by ${dimension.column}`, isWaiting },
			[
				columnHead(h, { label: dimension.column, width: LEAD_COLUMN }),
				columnHead(h, { label: "Requests", width: "w-24", align: "right" }),
				columnHead(h, { label: "5xx", width: "w-20", align: "right" }),
				columnHead(h, { label: "Error rate", width: "w-20", align: "right" }),
				columnHead(h, {
					label: "Cache hit",
					width: "w-20",
					align: "right",
					hidden: "hidden md:flex",
				}),
				...(hasBytes
					? [
							columnHead(h, {
								label: "Bandwidth",
								width: "w-24",
								align: "right",
								hidden: "hidden md:flex",
							}),
						]
					: []),
			],
			shown.length === 0
				? [dataTableEmpty(h, ["No requests in this window"])]
				: Arr.map(shown, (row) => breakdownRow(h, row, total, hasBytes)),
		),
		...(rows.length === 0 || footer === null ? [] : [footer]),
	]
}

/** The `status` narrowing: a removable chip once set, else the toggles that set it. */
const statusFilter = (h: H, model: Model): ReadonlyArray<Html> => {
	const status = model.search.status
	if (status !== undefined)
		return [
			removableChip(h, {
				label: `status = ${status}`,
				onRemove: Message.ClickedBreakdownStatus({ status: null }),
			}),
		]
	return Arr.map(["5xx", "4xx"] as const, (value) =>
		filterChip(
			h,
			{
				isPressed: false,
				onClick: Message.ClickedBreakdownStatus({ status: value }),
				size: "xs",
				hasDot: true,
				tone: value === "5xx" ? "crit" : "warn",
			},
			[`${value} only`],
		),
	)
}

/** `VercelBreakdownPanel`: the project's requests grouped by one log attribute. */
export const breakdownPanel = (h: H, model: Model): Html => {
	const by = breakdownByOf(model)
	const dimension = DIMENSIONS[by]
	const body = AsyncData.match(model.breakdown.data, {
		onIdle: () => [skeleton(h, "mx-4 mb-3 h-40")],
		onLoading: () => [skeleton(h, "mx-4 mb-3 h-40")],
		onFailure: (failure) => [
			errorState(h, {
				failure,
				title: `Couldn't load the ${dimension.column} breakdown`,
				onRetry: Message.ClickedRetryBreakdown(),
				variant: "row",
			}),
		],
		onStale: ({ error }) => [
			errorState(h, {
				failure: error,
				title: `Couldn't load the ${dimension.column} breakdown`,
				onRetry: Message.ClickedRetryBreakdown(),
				variant: "row",
			}),
		],
		onSuccess: (rows) => breakdownTable(h, dimension, rows, false),
		onRefreshing: (rows) => breakdownTable(h, dimension, rows, true),
	})
	return panel(h, {}, [
		panelHeader(h, {
			divided: false,
			className: "gap-y-2 px-4 pt-2.5 pb-2",
			action: segmentedSelect(h, {
				size: "xs",
				ariaLabel: "Breakdown dimension",
				options: Arr.map(VercelBreakdownBy.literals, (id) => ({
					value: id,
					label: DIMENSIONS[id].tab,
				})),
				value: by,
				onChange: (next) => Message.ClickedBreakdownBy({ by: next }),
			}),
			children: [
				hstack(h, { gap: "2", wrap: true }, [
					panelTitle(h, ["Breakdown"]),
					...statusFilter(h, model),
				]),
			],
		}),
		...body,
	])
}

// Top error logs

/** The error levels the logs explorer filters on for "error and fatal". */
const ERROR_SEVERITIES = ["ERROR", "FATAL"]

/** The logs explorer at this project's error and fatal logs, narrowed to a pattern's shared text. */
const patternLogsHref = (projectId: string, time: TimeSearch, search: string | null): string => {
	const errorLogs = { ...time, attrs: [...vercelProjectLogAttrs(projectId)], severities: ERROR_SEVERITIES }
	return hrefOf(AppRoute.Logs({ search: search === null ? errorLogs : { ...errorLogs, search } }))
}

type ErrorPattern = VercelInfraProjectDetailResponse["errors"][number]

const errorRow = (h: H, error: ErrorPattern, projectId: string, time: TimeSearch, clock: Clock): Html =>
	h.div(
		[h.Key(`${error.source}:${error.pattern}`), h.Class(cn(ROW_CLASS, "items-start"))],
		[
			vstack(h, { gap: "1", className: LEAD_COLUMN }, [
				hstack(h, { gap: "2", align: "baseline", className: "min-w-0" }, [
					...(error.source === ""
						? []
						: [badge(h, { variant: "muted", size: "xs", mono: true }, [error.source])]),
					typography(
						h,
						{
							size: "xs",
							tone: "foreground",
							mono: true,
							truncate: true,
							attributes: [h.Title(error.pattern)],
						},
						[error.pattern === "" ? "(empty message)" : error.pattern],
					),
				]),
				// The newest line in full: the pattern hides the ids and values that tell lines apart.
				typography(
					h,
					{
						size: "2xs",
						tone: "muted",
						mono: true,
						className: "line-clamp-3 break-all whitespace-pre-wrap",
						attributes: [h.Title(error.sample)],
					},
					[error.sample],
				),
			]),
			h.span([h.Class(cn(NUMERIC_CELL, "w-16", TONE_TEXT.crit))], [formatNumber(error.occurrences)]),
			h.span(
				[h.Class("w-18 text-right")],
				[
					relativeTime(h, {
						value: error.lastSeen,
						...clock,
						variant: "short",
						mono: true,
						className: typographyClass({ size: "2xs", tone: "muted" }),
					}),
				],
			),
			hstack(h, { gap: "3", justify: "end", className: "w-28" }, [
				...(error.traceId === null
					? []
					: [
							typography(h, { size: "xs" }, [
								textLink(
									h,
									{
										href: hrefOf(AppRoute.Trace({ traceId: error.traceId, search: {} })),
										attributes: [h.AriaLabel(`Newest trace: ${error.pattern}`)],
									},
									["Trace"],
								),
							]),
						]),
				typography(h, { size: "xs" }, [
					textLink(
						h,
						{
							href: patternLogsHref(projectId, time, error.search),
							attributes: [h.AriaLabel(`Logs: ${error.pattern}`)],
						},
						["Logs"],
					),
				]),
			]),
		],
	)

export const topErrors = (
	h: H,
	options: Readonly<{
		errors: VercelInfraProjectDetailResponse["errors"]
		/** The window had more error logs than the patterns were clustered from. */
		capped: boolean
		sampled: number
		projectId: string
		time: TimeSearch
		clock: Clock
	}>,
): Html =>
	h.section(
		[h.Class("min-w-0 space-y-3")],
		[
			sectionHeading(h, {
				title: "Top errors",
				hint: options.capped
					? `error and fatal logs grouped by pattern, from the newest ${formatNumber(options.sampled)}`
					: "error and fatal logs grouped by pattern",
				count: String(options.errors.length),
				actions: typography(h, { size: "xs" }, [
					textLink(
						h,
						{ href: patternLogsHref(options.projectId, options.time, null), tone: "muted" },
						["Open in Logs"],
					),
				]),
			}),
			dataTable(
				h,
				{ ariaLabel: "Top errors" },
				[
					columnHead(h, { label: "Pattern · newest line", width: LEAD_COLUMN }),
					columnHead(h, { label: "Count", width: "w-16", align: "right" }),
					columnHead(h, { label: "Last seen", width: "w-18", align: "right" }),
					columnHead(h, { label: "Investigate", width: "w-28", align: "right" }),
				],
				options.errors.length === 0
					? [dataTableEmpty(h, ["No error logs in this window"])]
					: Arr.map(options.errors, (error) =>
							errorRow(h, error, options.projectId, options.time, options.clock),
						),
			),
		],
	)

/** The logs explorer at this project's error logs. */
export const errorLogsHref = (projectId: string, time: TimeSearch): string =>
	hrefOf(AppRoute.Logs({ search: { ...time, attrs: [...vercelProjectLogAttrs(projectId)] } }))
