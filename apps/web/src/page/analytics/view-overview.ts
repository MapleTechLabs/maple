import { countryLabel, languageLabel, referrerLabel, utmLabel } from "../../components/analytics/labels"
import {
	ANALYTICS_METRICS,
	type AnalyticsMetricDescriptor,
	type AnalyticsMetricSource,
	findMetric,
	isMetricAvailable,
	metricDelta,
} from "../../components/analytics/metrics"
import { EMPTY_VALUE, formatNumber, formatPercent } from "@maple/ui/lib/format"
import { formatTimestampInTimezone } from "@maple/web-data/lib/timezone-format"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../route"
import { chartLoading } from "../../ui/chart-state"
import { errorState } from "../../ui/error-state"
import { icon } from "../../ui/icon"
import { delta } from "../../ui/delta"
import { listRow } from "../../ui/list-row"
import { panel, panelHeader } from "../../ui/panel"
import { skeleton } from "../../ui/skeleton"
import { truncatedId } from "../../ui/truncated-id"
import { sectionHeading } from "../kit/section-heading"
import { docsLink } from "../kit/signal-empty-state"
import { statRailItem, statRailItemSkeleton } from "../kit/stat-rail"
import { Message } from "./message"
import type { Model, Summary } from "./model"
import { filtersOf } from "./requests"
import { type BreakdownCard, breakdownPanel } from "./view-breakdown"
import { trafficChart } from "./view-chart"
import { favicon } from "./view-icons"

// `AnalyticsContent`: bot notice, metric strip, traffic chart, the
// breakdown cards and the traces behind a filtered event.

type H = HtmlBuilder<Message>

const GRID =
	"grid grid-cols-2 divide-x divide-y divide-border overflow-hidden rounded-md border bg-card @min-[880px]/page:grid-cols-4"
const TILE_NARROW = "@max-[560px]/page:px-4 @max-[560px]/page:py-3"

const dataOf = <A>(slot: { readonly data: AsyncData.AsyncData<A, unknown> }): A | undefined =>
	Option.getOrUndefined(AsyncData.getData(slot.data))

/** `AnalyticsBotNotice`: shown once bots are at least 5% of the window's sessions. */
const botNotice = (h: H, mix: Summary, traffic: string | undefined): Html | null => {
	if (mix.botShare === null || mix.botShare < 0.05) return null
	const excluded =
		traffic === "bots"
			? "the only sessions counted below"
			: traffic === "all"
				? "counted in every number below"
				: "excluded from every number below"
	return panel(h, { className: "flex-row flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-sm text-muted-foreground" }, [
		icon(h, "FaceRobotIcon", { size: 14, className: "shrink-0 text-muted-foreground" }),
		h.span([h.Class("text-foreground")], [formatPercent(mix.botShare), " of recorded sessions are bots"]),
		h.span([], [
			formatNumber(mix.botSessions),
			" of ",
			formatNumber(mix.sessions),
			` sessions came from crawlers or automated browsers, and are ${excluded}. Change that under Traffic in the sidebar.`,
		]),
	])
}

const metricStrip = (
	h: H,
	source: AnalyticsMetricSource,
	previous: AnalyticsMetricSource | undefined,
	selected: string,
): Html =>
	h.div(
		[h.Class(GRID)],
		ANALYTICS_METRICS.map((metric, index) => {
			const isAvailable = isMetricAvailable(metric, source)
			const value = metric.value(source)
			const change = isAvailable ? metricDelta(metric, source, previous) : null
			return statRailItem(h, {
				eyebrow: metric.label,
				value: isAvailable && value !== null ? metric.format(value) : EMPTY_VALUE,
				spark: isAvailable ? metric.series(source).map((point) => point.value) : undefined,
				delta: change === null ? undefined : delta(h, { ratio: change, invert: metric.invertDelta }),
				subline: isAvailable ? metric.subline(source) : "No visitor ids",
				isSelected: metric.key === selected,
				isDisabled: !isAvailable,
				onSelect: Message.PickedMetric({ metric: metric.key }),
				delay: (index % 4) * 60,
				className: TILE_NARROW,
				valueClassName: "@max-[560px]/page:text-[22px]",
			})
		}),
	)

/** `pairedCompanion`: the selected metric's companion, when it reports something. */
const pairedCompanion = (metric: AnalyticsMetricDescriptor, source: AnalyticsMetricSource) => {
	if (metric.companion === undefined) return undefined
	const companion = findMetric(metric.companion)
	return isMetricAvailable(companion, source) ? companion : undefined
}

const summarySection = (h: H, model: Model, timeZone: string, isNarrow: boolean): ReadonlyArray<Html> =>
	AsyncData.matchData(model.summary.data, {
		onEmpty: () => [
			h.div(
				[h.Class(GRID), h.AriaBusy(true)],
				ANALYTICS_METRICS.map(() => statRailItemSkeleton(h, TILE_NARROW)),
			),
			chartLoading(h, { variant: "area", height: 224 }),
		],
		onFailure: (failure) => [
			errorState(h, { failure, title: "Failed to load analytics summary", onRetry: Message.ClickedRetrySummary() }),
		],
		onData: (summary) => {
			const source: AnalyticsMetricSource = {
				summary,
				timeseries: dataOf(model.timeseries) ?? [],
				pageviews: dataOf(model.pageviews) ?? [],
			}
			const previousSummary = dataOf(model.previousSummary)
			const previous: AnalyticsMetricSource | undefined =
				previousSummary === undefined
					? undefined
					: { summary: previousSummary, timeseries: [], pageviews: dataOf(model.previousPageviews) ?? [] }
			const picked = model.pickedMetric === null ? undefined : ANALYTICS_METRICS.find((m) => m.key === model.pickedMetric)
			const metric =
				picked !== undefined && isMetricAvailable(picked, source)
					? picked
					: (ANALYTICS_METRICS.find((candidate) => isMetricAvailable(candidate, source)) ?? findMetric("visitors"))
			const mix = dataOf(model.mix) ?? (model.mix.key === model.summary.key ? summary : undefined)
			const notice = mix === undefined ? null : botNotice(h, mix, filtersOf(model.search).traffic)
			return [
				...(notice === null ? [] : [notice]),
				metricStrip(h, source, previous, metric.key),
				...(model.themeColors === null
					? []
					: [
							h.submodel({
								slotId: "analytics-traffic-chart",
								model: model.chart,
								view: trafficChart,
								viewInputs: {
									metricKey: metric.key,
									companionKey: pairedCompanion(metric, source)?.key,
									source,
									theme: model.themeColors,
									timeZone,
									isNarrow,
								},
								toParentMessage: (message) => Message.GotChartMessage({ message }),
							}),
						]),
			]
		},
	})

/** The overview's cards, built from the page's data (the dialog reads the same list). */
export const overviewCards = (model: Model): ReadonlyArray<BreakdownCard & { readonly isWide?: boolean }> => {
	const breakdowns = dataOf(model.breakdowns)
	if (breakdowns === undefined) return []
	const pages = dataOf(model.pages) ?? []
	const isMultiSite = new Set(pages.map((page) => page.host)).size > 1
	const events = dataOf(model.events) ?? []
	return [
		{
			id: "acquisition",
			dimensions: [
				{ tab: "Referrers", rows: breakdowns.referrerHosts, filterKey: "referrerHost", noun: "referrer", nounPlural: "referrers", formatValue: referrerLabel },
				{ tab: "UTM source", rows: breakdowns.utmSources, filterKey: "utmSource", noun: "source", nounPlural: "sources", formatValue: utmLabel },
				{ tab: "Medium", rows: breakdowns.utmMediums, filterKey: "utmMedium", noun: "medium", nounPlural: "mediums", formatValue: utmLabel },
				{ tab: "Campaign", rows: breakdowns.utmCampaigns, filterKey: "utmCampaign", noun: "campaign", nounPlural: "campaigns", formatValue: utmLabel },
			],
		},
		{
			id: "content",
			dimensions: [
				{
					tab: "Pages",
					rows: pages.map((page) => ({ name: page.pagePath, count: page.sessions, views: page.pageViews, secondary: page.host })),
					filterKey: "pagePath",
					noun: "page",
					nounPlural: "pages",
					renderIcon: isMultiSite
						? (h: H, row: { readonly secondary?: string }) => favicon(h, model, row.secondary ?? "")
						: undefined,
					emptyMessage: (h: H) => [
						"No page views in the selected window.",
						h.span([h.Class("mt-2 flex justify-center")], [docsLink(h, "webAnalytics")]),
					],
				},
				{ tab: "Entries", rows: breakdowns.entryPaths, filterKey: "pagePath", noun: "entry page", nounPlural: "entry pages" },
				{ tab: "Exits", rows: breakdowns.exitPaths, filterKey: "pagePath", noun: "exit page", nounPlural: "exit pages" },
			],
		},
		{
			id: "technology",
			dimensions: [
				{ tab: "Devices", rows: breakdowns.deviceTypes, filterKey: "deviceType", noun: "device", nounPlural: "devices" },
				{ tab: "Browsers", rows: breakdowns.browsers, filterKey: "browserName", noun: "browser", nounPlural: "browsers" },
				{ tab: "OS", rows: breakdowns.operatingSystems, filterKey: "osName", noun: "OS", nounPlural: "operating systems" },
			],
		},
		{
			id: "audience",
			dimensions: [
				{
					tab: "Countries",
					rows: breakdowns.countries,
					filterKey: "country",
					noun: "country",
					nounPlural: "countries",
					formatValue: countryLabel,
					emptyMessage: () => [
						"No geo data. Country is resolved at the ingest gateway from the Cloudflare edge header, and only for traffic received after that was enabled — it is never backfilled.",
					],
				},
				{ tab: "Languages", rows: breakdowns.languages, filterKey: "language", noun: "language", nounPlural: "languages", formatValue: languageLabel },
				{ tab: "Sites", rows: breakdowns.hosts, filterKey: "host", noun: "site", nounPlural: "sites" },
			],
		},
		{
			id: "events",
			isWide: true,
			dimensions: [
				{
					tab: "Events",
					rows: events.map((event) => ({ name: event.name, count: event.sessions, views: event.events })),
					filterKey: "eventName",
					noun: "event",
					nounPlural: "events",
					viewsLabel: "Events",
					emptyMessage: (h: H) => [
						'No custom events in the selected window. Send one with track("name", props) from the browser SDK.',
						h.span([h.Class("mt-2 flex justify-center")], [docsLink(h, "productEventsApi")]),
					],
				},
			],
		},
	]
}

/** `ProductEventTraceSamples`: the traces behind a filtered event, when it came from a span. */
const traceSamples = (h: H, model: Model, eventName: string, timeZone: string): Html | null => {
	const header = panelHeader(h, {
		className: "justify-start gap-2 px-3 py-2",
		children: [
			icon(h, "ChartBarTrendUpIcon", { className: "size-3.5 text-muted-foreground" }),
			sectionHeading(h, { title: `Traces behind “${eventName}”` }),
		],
	})
	return AsyncData.matchData(model.traceSamples.data, {
		onEmpty: () => null,
		onFailure: (failure) =>
			panel(h, {}, [
				header,
				errorState(h, { failure, title: "Could not load traces for this event", variant: "inline", className: "px-3 py-2" }),
			]),
		onData: (samples) =>
			samples.length === 0
				? null
				: panel(h, {}, [
						header,
						h.ul(
							[h.Class("divide-y")],
							samples.map((sample, index) =>
								h.li([h.Key(`${index}:${sample.traceId}:${sample.spanId}`)], [
									listRow(h, {
										density: "compact",
										className: "gap-2 py-2",
										href: hrefOf(
											AppRoute.Trace({ traceId: sample.traceId, search: { spanId: sample.spanId, t: sample.timestamp } }),
										),
										leading: truncatedId(h, { value: sample.traceId, kind: "trace" }),
										title: h.span([h.Class("font-normal")], [
											sample.serviceName,
											...(sample.userId || sample.visitorId
												? [
														h.span([h.Class("text-muted-foreground")], [
															sample.serviceName === "" ? "" : " ",
															"· ",
															sample.userId || sample.visitorId,
														]),
													]
												: []),
										]),
										trailing: h.span([h.Class("text-muted-foreground")], [
											formatTimestampInTimezone(sample.timestamp, { timeZone }),
										]),
									}),
								]),
							),
						),
					]),
	})
}

const breakdownSection = (h: H, model: Model, timeZone: string): Html =>
	AsyncData.matchData(model.breakdowns.data, {
		onEmpty: () =>
			h.div([h.Class("grid gap-4 @min-[880px]/page:grid-cols-2")], [skeleton(h, "h-72 w-full"), skeleton(h, "h-72 w-full")]),
		onFailure: (failure) =>
			errorState(h, { failure, title: "Failed to load breakdowns", onRetry: Message.ClickedRetryBreakdowns() }),
		onData: () => {
			const filters = filtersOf(model.search)
			const isWaiting = AsyncData.isRefreshing(model.breakdowns.data)
			const samples = filters.eventName === undefined ? null : traceSamples(h, model, filters.eventName, timeZone)
			return h.div([h.Class("grid items-start gap-4 @min-[880px]/page:grid-cols-2")], [
				...overviewCards(model).map((card) =>
					h.div([h.Key(card.id), ...(card.isWide === true ? [h.Class("@min-[880px]/page:col-span-2")] : [])], [
						breakdownPanel(h, model, card, { selectedOf: (key) => filters[key], isWaiting }) ?? h.div([], []),
					]),
				),
				...(samples === null ? [] : [h.div([h.Class("@min-[880px]/page:col-span-2")], [samples])]),
			])
		},
	})

/** `AnalyticsContent`. */
export const overviewContent = (h: H, model: Model, timeZone: string, isNarrow = false): Html =>
	h.div([h.Class("space-y-6")], [...summarySection(h, model, timeZone, isNarrow), breakdownSection(h, model, timeZone)])
