import {
	searchConsoleSiteLabel,
	type SearchConsoleIntegrationStatus,
	type SearchConsoleLandingPage,
	type SearchConsoleOverview,
	type SearchConsoleSiteStatus,
	type SearchConsoleSortKey,
} from "@maple/domain/http"
import { completeThrough, pacificToday, searchConsoleCoverage } from "@maple/domain/search-console"
import { EMPTY_VALUE, formatNumber, formatPercent, pluralize } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { Option, Array as Arr, Order, Record as Rec, String as Str } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../route"
import { alert, alertDescription, alertTitle } from "@maple/views/ui/alert"
import { button, linkButton } from "@maple/views/ui/button"
import { delta } from "@maple/views/ui/delta"
import {
	empty,
	emptyContent,
	emptyDescription,
	emptyHeader,
	emptyMedia,
	emptyMessage,
	emptyTitle,
} from "@maple/views/ui/empty"
import { errorState } from "@maple/views/ui/error-state"
import { heading } from "@maple/views/ui/heading"
import { icon } from "@maple/views/ui/icon"
import { nativeOption, nativeSelect } from "@maple/views/ui/native-select"
import { revealIcon } from "@maple/views/ui/reveal-icon"
import { stripClass } from "@maple/views/ui/rule"
import { emptyActions } from "@maple/views/ui/signal-empty-state"
import { skeleton } from "@maple/views/ui/skeleton"
import { hstack, vstack } from "@maple/views/ui/stack"
import { rowLink } from "@maple/views/ui/table"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { columnClass } from "@maple/views/ui/column"
import { columnHead, dataTable, dataTableEmpty, skeletonRows } from "../kit/data-table"
import {
	integrationEmpty,
	integrationEmptyCard,
	integrationEmptyFeatures,
	integrationEmptyFooter,
	integrationEmptyHint,
	integrationEmptyMedia,
} from "../kit/integration-empty"
import { providerBrand } from "../kit/providers"
import { sectionHeading } from "../kit/section-heading"
import { sortRows } from "../kit/table-sort"
import { METRIC_TILE, metricGrid, statRailItem, statRailItemSkeleton } from "../kit/stat-rail"
import { Message } from "./message"
import { type Model, SearchTable } from "./model"
import { filtersOf, searchSiteOf, searchSortOf } from "./requests"
import { SEARCH_METRICS, searchMetricOf, type SearchMetrics } from "./search-metrics"
import { panelOf, SEARCH_DATA_SLOTS } from "./update"
import { columnLabel, panelFilterInput, shareBarStyle } from "./view-breakdown"
import { analyticsPanel, CARD_SURFACE, DIALOG_SURFACE } from "./view-panel"
import { searchTrendChart, searchTrendHeading, type SearchTrendInputs } from "./view-search-chart"
import { chartCard } from "../kit/chart-card"
import * as Keyed from "@maple/views/data/keyed"
import { isSameFailure, type LoadFailure } from "@maple/views/data/load-failure"

// The Search tab: Google Search Console performance for one property, beside Maple's own
// sessions on the same pages.

type H = HtmlBuilder<Message>

const dataOf = <A>(slot: { readonly data: AsyncData.AsyncData<A, unknown> }): A | undefined =>
	Option.getOrUndefined(AsyncData.getData(slot.data))

const DAY_FORMAT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" })

/** A Google day (`YYYY-MM-DD`) as "Nov 7". */
const formatDay = (day: string): string => DAY_FORMAT.format(new Date(`${day}T00:00:00Z`))

const integrationsHref = hrefOf(AppRoute.Integrations({ search: { integration: "google-search-console" } }))

const BRAND = providerBrand("google-search-console")

/** What the tab shows once a property is connected. */
const FEATURES = [
	{
		label: "Queries",
		title: "What people searched",
		description: "Every search that showed your site, with its clicks, impressions, CTR and position.",
	},
	{
		label: "Pages",
		title: "Search next to sessions",
		description: "Google's numbers for each page beside the sessions that started on it.",
	},
	{
		label: "Trend",
		title: "Ranking by day",
		description: "Clicks, impressions, CTR and average position per day, against the period before.",
	},
] as const

/** The tab's waiting-room card: Google's mark, what is going on, and the one way forward. */
const searchCard = (
	h: H,
	options: Readonly<{ title: string; hint: string; action?: string; footer?: string }>,
): Html =>
	integrationEmptyCard(h, [
		integrationEmptyMedia(h, BRAND),
		heading(h, { level: 2, variant: "section" }, [options.title]),
		integrationEmptyHint(h, [options.hint]),
		...(options.action === undefined
			? []
			: [
					linkButton(h, { href: integrationsHref }, [
						options.action,
						icon(h, "ArrowRightIcon", { size: 14 }),
					]),
				]),
		...(options.footer === undefined ? [] : [integrationEmptyFooter(h, [options.footer])]),
	])

const notConnected = (h: H, status: SearchConsoleIntegrationStatus): Html =>
	status.revoked
		? searchCard(h, {
				title: "Reconnect Google Search Console",
				hint: "Google stopped accepting Maple's access to Search Console. Reconnect to keep importing clicks and impressions.",
				action: "Reconnect Search Console",
			})
		: status.connected
			? searchCard(h, {
					title: "Pick a Search Console property",
					hint: "Search Console is connected, but no property is selected. Choose the sites to import.",
					action: "Choose properties",
				})
			: integrationEmpty(
					h,
					[
						integrationEmptyFeatures(h, FEATURES),
						searchCard(h, {
							title: "See what people search before they land here",
							hint: "Connect Google Search Console to line up Google's clicks and rankings with how those visits behave on your site.",
							action: "Connect Search Console",
							footer: "Read-only access · the last two weeks arrive within about 15 minutes.",
						}),
					],
					// Where the features stack (a phone), the way to connect comes first.
					"@max-2xl/page:flex-col-reverse",
				)

const importing = (h: H): Html =>
	searchCard(h, {
		title: "Importing from Search Console",
		hint: "The first import brings in the last two weeks and lands within about 15 minutes. Older days fill in after that.",
		footer: "This page updates on its own when the first days are in.",
	})

const importError = (h: H, message: string, isBlocking: boolean): Html =>
	alert(h, { variant: isBlocking ? "crit" : "warn", size: "sm" }, [
		icon(h, "AlertWarningIcon"),
		alertTitle(h, [isBlocking ? "Couldn't import from Search Console" : "The latest import failed"]),
		alertDescription(h, [message]),
	])

/** The window or its comparison period reaches before the imported history. */
const historyImporting = (h: H, backfillDate: string | null): Html =>
	alert(h, { variant: "info", size: "sm" }, [
		icon(h, "ClockIcon"),
		alertTitle(h, [
			backfillDate === null
				? "History is still importing"
				: `History before ${formatDay(backfillDate)} is still importing`,
		]),
		alertDescription(h, ["Changes against the previous period show once those days are in."]),
	])

/** The property and how fresh its data is; with several properties the picker is the title. */
const propertyHeading = (
	h: H,
	status: SearchConsoleIntegrationStatus,
	site: SearchConsoleSiteStatus,
	through: string,
): Html => {
	const hint = `Data through ${formatDay(through)}. Google's latest days are preliminary and can still change.`
	const enabled = Arr.filter(status.sites, (candidate) => candidate.enabled)
	if (enabled.length < 2) return sectionHeading(h, { title: searchConsoleSiteLabel(site.siteUrl), hint })
	return hstack(h, { gap: "3", wrap: true, className: "gap-y-2" }, [
		nativeSelect(
			h,
			{
				size: "sm",
				defaultValue: site.siteUrl,
				attributes: [
					h.AriaLabel("Search Console property"),
					h.OnChange((siteUrl) => Message.PickedSearchSite({ siteUrl })),
				],
			},
			Arr.map(enabled, (candidate) =>
				nativeOption(candidate.siteUrl, searchConsoleSiteLabel(candidate.siteUrl)),
			),
		),
		typography(h, { size: "xs", tone: "muted" }, [hint]),
	])
}

/**
 * The four totals; the picked one is what the chart draws. Changes run against the previous
 * period, with position inverted (lower is better). With no impressions now there is nothing to
 * compare, so no tile shows a change; nor while either period's history is still importing.
 */
const kpis = (
	h: H,
	model: Model,
	overview: SearchConsoleOverview,
	spark: ReadonlyArray<SearchMetrics>,
	isComparable: boolean,
): Html => {
	const hasDeltas = overview.impressions > 0 && isComparable
	const picked = searchMetricOf(model.searchMetric)
	return metricGrid(
		h,
		{},
		Arr.map(SEARCH_METRICS, (metric) => {
			const previous = overview.previous[metric.key]
			const isCompared = hasDeltas && previous !== 0
			return statRailItem(h, {
				eyebrow: metric.label,
				value: metric.format(overview),
				spark: Arr.map(spark, (point) => point[metric.key]),
				delta: isCompared
					? delta(h, { current: overview[metric.key], previous, invert: metric.isInverted })
					: undefined,
				subline: isCompared ? `vs ${metric.format(overview.previous)} before` : undefined,
				isSelected: metric.key === picked.key,
				onSelect: Message.PickedSearchMetric({ metric: metric.key }),
				...METRIC_TILE,
			})
		}),
	)
}

/** The picked metric's chart; a failed read shows its error and retry, not an empty window. */
const trend = (h: H, model: Model, points: SearchTrendInputs["points"], isNarrow: boolean): Html | null => {
	const heading = searchTrendHeading(model.searchMetric)
	return AsyncData.matchData(model.searchTimeseries.data, {
		onEmpty: () => chartCard(h, heading, [skeleton(h, "m-4 h-40")]),
		onFailure: (failure) =>
			chartCard(h, heading, [
				errorState(h, {
					failure,
					variant: "row",
					title: "Couldn't load the search trend",
					onRetry: Message.ClickedRetrySearch(),
				}),
			]),
		onData: () =>
			model.themeColors === null
				? null
				: h.submodel({
						slotId: "analytics-search-chart",
						model: model.chart,
						view: searchTrendChart,
						viewInputs: {
							metric: searchMetricOf(model.searchMetric).key,
							points,
							theme: model.themeColors,
							isNarrow,
						},
						toParentMessage: (message) => Message.GotChartMessage({ message }),
					}),
	})
}

/** A column that only fits a wider card: its head and cells appear from that card width up. */
const FROM = {
	wide: { head: "hidden @min-[640px]/panel:flex", cell: "hidden @min-[640px]/panel:block" },
	full: { head: "hidden @min-[760px]/panel:flex", cell: "hidden @min-[760px]/panel:block" },
} as const

type Column<Row> = Readonly<{
	label: string
	width: string
	from?: keyof typeof FROM
	/** One of Google's four metrics, which the read can order by. */
	sortKey?: SearchConsoleSortKey
	tooltip?: string
	text: (row: Row) => string
	/** A zero or a blank: it reads quieter than a figure. */
	isQuiet: (row: Row) => boolean
	/** The first column that is Maple's own, ruled off from Google's four. */
	isOwnStart?: boolean
}>

/** The rule between Google's metrics and Maple's, on the head and every row alike. */
const OWN_START = "border-l border-border-subtle pl-3"

/** Each metric's column. A row's position is already an average, so its head just says Position. */
const METRIC_COLUMNS = {
	clicks: { label: "Clicks", width: "w-16" },
	impressions: { label: "Impressions", width: "w-24" },
	ctr: { label: "CTR", width: "w-14", from: "wide" },
	position: { label: "Position", width: "w-20", from: "wide" },
} as const satisfies Record<SearchConsoleSortKey, Readonly<{ label: string; width: string; from?: "wide" }>>

const metricColumns = <Row extends SearchMetrics>(): ReadonlyArray<Column<Row>> =>
	Arr.map(SEARCH_METRICS, (metric) => ({
		...METRIC_COLUMNS[metric.key],
		sortKey: metric.key,
		text: metric.format,
		isQuiet: (row) => row[metric.key] === 0,
	}))

/** Google's four, then Maple's own: the human sessions that entered on the page from anywhere. */
const pageColumns = (
	rows: ReadonlyArray<SearchConsoleLandingPage>,
	eventName: string | undefined,
): ReadonlyArray<Column<SearchConsoleLandingPage>> => [
	...metricColumns<SearchConsoleLandingPage>(),
	{
		label: "Sessions",
		width: "w-24",
		from: "full",
		tooltip:
			eventName === undefined
				? "Every human session that started on this page, from any referrer. Pick an event in the sidebar to count the ones that converted."
				: "Every human session that started on this page, from any referrer",
		text: (row) => formatNumber(row.sessions),
		isQuiet: (row) => row.sessions === 0,
		isOwnStart: true,
	},
	{
		label: "Bounce",
		width: "w-16",
		from: "full",
		text: (row) => (row.bounceRate === null ? EMPTY_VALUE : formatPercent(row.bounceRate)),
		isQuiet: (row) => row.bounceRate === null,
	},
	...(Arr.some(rows, (row) => row.conversions !== null)
		? [
				{
					label: "Conversions",
					width: "w-28",
					from: "full" as const,
					tooltip:
						eventName === undefined
							? undefined
							: `Sessions that started on this page and fired ${eventName}`,
					text: (row: SearchConsoleLandingPage) =>
						row.conversions === null ? EMPTY_VALUE : formatNumber(row.conversions),
					isQuiet: (row: SearchConsoleLandingPage) =>
						row.conversions === null || row.conversions === 0,
				},
			]
		: []),
]

/** One of the tab's two tables: what its rows are called and how a row draws its name. */
type TableSpec<Row extends SearchMetrics> = Readonly<{
	table: SearchTable
	title: string
	hint: string
	noun: string
	nounPlural: string
	columns: ReadonlyArray<Column<Row>>
	/** The name as shown: its tooltip, and what a name sort orders by. */
	name: (row: Row) => string
	/** What the filter matches, when a row is found by more than its name shows. */
	search?: (row: Row) => string
	nameCell: (h: H, row: Row) => ReadonlyArray<Html | string>
	key: (row: Row) => string
	/** Where the row leads, in a new tab; a row without one is plain. */
	href?: (row: Row) => string
}>

/** A table's card id: its filter text in `panels`, and the dialog it expands into. */
const panelIdOf = (table: SearchTable): string => `search-${table}`

/** Whether the expand dialog is showing one of the Search tables. */
export const isSearchPanel = (panelId: string | null): boolean =>
	Arr.some(SearchTable.literals, (table) => panelIdOf(table) === panelId)

const SURFACES = { card: CARD_SURFACE, dialog: DIALOG_SURFACE } as const

/**
 * The table, its head pinned over a capped row area. The bar behind a row is its share of the
 * top row's volume: clicks under a clicks or name sort, impressions under any other. The
 * dialog numbers its rows and keeps every column, scrolling sideways on a phone.
 */
const searchTable = <Row extends SearchMetrics>(
	h: H,
	model: Model,
	spec: TableSpec<Row>,
	rows: ReadonlyArray<Row>,
	options: Readonly<{ isStale: boolean; surface: keyof typeof SURFACES }>,
): Html => {
	const sort = searchSortOf(model, spec.table)
	const isDialog = options.surface === "dialog"
	const sortKey = sort.key
	// A metric sort is the read's own order; names, and rows from an earlier sort, sort here.
	const ordered =
		sortKey === "name" || options.isStale
			? sortRows(rows, sort, (row) => (sortKey === "name" ? spec.name(row) : row[sortKey]))
			: rows
	const barKey = sortKey === "clicks" || sortKey === "name" ? "clicks" : "impressions"
	const top = Arr.reduce(rows, 0, (max, row) => Math.max(max, row[barKey]))
	const needle = Str.toLowerCase(Str.trim(panelOf(model, panelIdOf(spec.table)).query))
	const searched = spec.search ?? spec.name
	const visible = Arr.filter(
		ordered,
		(row) => needle === "" || Str.includes(needle)(Str.toLowerCase(searched(row))),
	)
	const hiddenBelow = (column: Column<Row>) =>
		isDialog || column.from === undefined ? undefined : FROM[column.from]
	const nameColumn = columnClass({ min: "0", className: isDialog ? "max-sm:min-w-48" : undefined })
	const sortHead = (key: SearchConsoleSortKey | "name") => ({
		isActive: sortKey === key,
		dir: sort.dir,
		onSort: Message.ClickedSearchSort({ table: spec.table, key }),
	})
	const head = [
		...(isDialog
			? [
					columnHead(h, {
						label: "#",
						width: "w-6",
						align: "right",
						hidden: "max-sm:hidden",
						isTable: true,
					}),
				]
			: []),
		columnHead(h, {
			label: columnLabel(spec.noun),
			width: nameColumn,
			sort: sortHead("name"),
			isTable: true,
		}),
		...Arr.map(spec.columns, (column) =>
			columnHead(h, {
				label: column.label,
				width: column.width,
				className: cn("shrink-0", column.isOwnStart === true && OWN_START),
				align: "right",
				sort: column.sortKey === undefined ? undefined : sortHead(column.sortKey),
				tooltip: column.tooltip,
				hidden: hiddenBelow(column)?.head,
				isTable: true,
			}),
		),
	]
	const nameOf = (row: Row): Html => {
		const name = spec.name(row)
		const href = spec.href?.(row)
		const text = { size: "xs", tone: "soft", truncate: true } as const
		return href === undefined
			? typography(h, { ...text, attributes: [h.Title(name)] }, spec.nameCell(h, row))
			: rowLink(
					h,
					{
						href,
						label: `${name}, opens in a new tab`,
						className: typographyClass({ ...text, className: "group-hover:text-foreground" }),
						attributes: [h.Title(name), h.Target("_blank"), h.Rel("noopener noreferrer")],
					},
					spec.nameCell(h, row),
				)
	}
	const cells = (row: Row, rank: number): ReadonlyArray<Html> => [
		...(isDialog
			? [
					typography(
						h,
						{
							size: "2xs",
							mono: true,
							numeric: true,
							tone: "subtle",
							className: "w-6 shrink-0 text-right max-sm:hidden",
							attributes: [h.Role("cell")],
						},
						[String(rank)],
					),
				]
			: []),
		hstack(h, { gap: "2", grow: true, as: "span", className: nameColumn, attributes: [h.Role("cell")] }, [
			nameOf(row),
			...(spec.href === undefined ? [] : [revealIcon(h, "ExternalLinkIcon", { size: 12 })]),
		]),
		...Arr.map(spec.columns, (column) =>
			typography(
				h,
				{
					size: "xs",
					mono: true,
					numeric: true,
					tone: column.isQuiet(row)
						? "subtle"
						: column.sortKey === sortKey
							? "foreground"
							: "muted",
					className: cn(
						"shrink-0 text-right",
						column.width,
						column.isOwnStart === true && OWN_START,
						hiddenBelow(column)?.cell,
					),
					attributes: [h.Role("cell")],
				},
				[column.text(row)],
			),
		),
	]
	// A linked row tints under the pointer; its link is stretched over it, so it needs a frame.
	const rowClass = stripClass(
		"row",
		cn("group relative", spec.href !== undefined && "hover:bg-surface-sunken active:bg-surface-sunken"),
	)
	const body =
		visible.length === 0
			? [dataTableEmpty(h, [`No ${spec.noun} matches that filter`])]
			: Arr.map(visible, (row, index) =>
					hstack(
						h,
						{
							gap: "4",
							className: rowClass,
							attributes: [
								h.Key(spec.key(row)),
								h.Role("row"),
								h.Style(shareBarStyle(top > 0 ? row[barKey] / top : 0, "quiet")),
							],
						},
						cells(row, index + 1),
					),
				)
	return dataTable(
		h,
		{
			ariaLabel: spec.title,
			isWaiting: options.isStale,
			isTable: true,
			...SURFACES[options.surface],
		},
		head,
		body,
	)
}

const QUERIES: TableSpec<SearchMetrics & Readonly<{ query: string }>> = {
	table: "queries",
	title: "Queries",
	hint: "What people searched to find this site. Google leaves out rare queries.",
	noun: "query",
	nounPlural: "queries",
	columns: metricColumns(),
	name: (row) => row.query,
	nameCell: (_h, row) => [row.query],
	key: (row) => row.query,
}

/**
 * The host most of the rows are on, which a path need not repeat: the busier one on a tie, so
 * the pick does not move with the sort.
 */
const commonHostOf = (rows: ReadonlyArray<SearchConsoleLandingPage>): string | undefined => {
	const hosts = Arr.map(Rec.toEntries(Arr.groupBy(rows, (row) => row.host)), ([host, onHost]) => ({
		host,
		pages: onHost.length,
		clicks: Arr.reduce(onHost, 0, (sum, row) => sum + row.clicks),
	}))
	type Host = (typeof hosts)[number]
	const most = Arr.head(
		Arr.sort(
			hosts,
			Order.combineAll([
				Order.mapInput(Order.flip(Order.Number), (entry: Host) => entry.pages),
				Order.mapInput(Order.flip(Order.Number), (entry: Host) => entry.clicks),
				Order.mapInput(Order.String, (entry: Host) => entry.host),
			]),
		),
	)
	return Option.getOrUndefined(Option.map(most, (entry) => entry.host))
}

const pagesSpec = (
	model: Model,
	rows: ReadonlyArray<SearchConsoleLandingPage>,
): TableSpec<SearchConsoleLandingPage> => {
	const commonHost = commonHostOf(rows)
	return {
		table: "pages",
		title: "Pages",
		hint: "Google's numbers for each page, next to the sessions that started on it",
		noun: "page",
		nounPlural: "pages",
		columns: pageColumns(rows, filtersOf(model.search).eventName),
		name: (row) => (row.host === commonHost ? row.path : `${row.host}${row.path}`),
		search: (row) => `${row.host}${row.path}`,
		// Only a page on another host (a docs or status subdomain) says which.
		nameCell: (h, row) =>
			row.host === commonHost ? [row.path] : [typography(h, { tone: "subtle" }, [row.host]), row.path],
		key: (row) => `${row.host}${row.path}`,
		href: (row) => row.page,
	}
}

/** What stands in for a table with no rows to draw: skeleton rows, the failure and its retry, or an empty line. */
const tableFallback = <Row extends SearchMetrics>(
	h: H,
	slot: Keyed.Keyed<ReadonlyArray<Row>, LoadFailure>,
	spec: TableSpec<Row>,
): Html | null =>
	AsyncData.matchData(slot.data, {
		onEmpty: () =>
			h.div(
				[h.AriaBusy(true)],
				skeletonRows(h, 8, () => [
					skeleton(h, "h-3 w-0 flex-1"),
					skeleton(h, "h-3 w-10"),
					skeleton(h, "h-3 w-14"),
				]),
			),
		onFailure: (failure) =>
			errorState(h, {
				failure,
				variant: "row",
				title: `Couldn't load ${spec.nounPlural}`,
				onRetry: Message.ClickedRetrySearch(),
			}),
		onData: (rows) =>
			rows.length === 0
				? emptyMessage(h, { className: "py-10" }, [`No ${spec.nounPlural} in this window`])
				: null,
	})

type SpecOf<Row extends SearchMetrics> = (rows: ReadonlyArray<Row>) => TableSpec<Row>

/** A table's card: the capped table under its filter, or what stands in for it. */
const tableCard = <Row extends SearchMetrics>(
	h: H,
	model: Model,
	slot: Keyed.Keyed<ReadonlyArray<Row>, LoadFailure>,
	specOf: SpecOf<Row>,
): Html => {
	const rows = dataOf(slot) ?? []
	const spec = specOf(rows)
	const panelId = panelIdOf(spec.table)
	const fallback = tableFallback(h, slot, spec)
	if (fallback !== null) return analyticsPanel(h, { title: spec.title, hint: spec.hint }, [fallback])
	return analyticsPanel(h, {
		title: spec.title,
		hint: spec.hint,
		aside: panelFilterInput(
			h,
			panelId,
			panelOf(model, panelId).query,
			spec.nounPlural,
			"w-40 @min-[640px]/panel:w-56",
		),
		expand: {
			id: panelId,
			count: `${formatNumber(rows.length)} ${pluralize(rows.length, spec.noun, spec.nounPlural)}`,
			table: searchTable(h, model, spec, rows, {
				surface: "card",
				isStale: AsyncData.isRefreshing(slot.data),
			}),
		},
	})
}

/** A table card's dialog: the same rows, numbered, in a taller frame with every column. */
export const searchDialogTable = (
	h: H,
	model: Model,
	panelId: string,
): Readonly<{ title: string; hint: string; filter: Html; table: Html }> | null => {
	const dialog = <Row extends SearchMetrics>(
		slot: Keyed.Keyed<ReadonlyArray<Row>, LoadFailure>,
		specOf: SpecOf<Row>,
	) => {
		const rows = dataOf(slot) ?? []
		const spec = specOf(rows)
		return {
			title: spec.title,
			hint: spec.hint,
			filter: panelFilterInput(
				h,
				panelId,
				panelOf(model, panelId).query,
				spec.nounPlural,
				"w-56",
				"-dialog",
				true,
			),
			// A sort is a new read: if it fails, the dialog says so instead of going blank.
			table:
				tableFallback(h, slot, spec) ??
				searchTable(h, model, spec, rows, {
					surface: "dialog",
					isStale: AsyncData.isRefreshing(slot.data),
				}),
		}
	}
	if (panelId === panelIdOf("queries")) return dialog(model.searchQueries, () => QUERIES)
	if (panelId === panelIdOf("pages")) return dialog(model.searchLanding, (rows) => pagesSpec(model, rows))
	return null
}

/**
 * Every read failing the same way, with nothing to show, reads as one failure with one Try
 * again. A failed refresh keeps its rows, so it does not count.
 */
const sharedFailure = (model: Model): LoadFailure | undefined => {
	const slots: ReadonlyArray<Keyed.Keyed<unknown, LoadFailure>> = Arr.map(
		SEARCH_DATA_SLOTS,
		(name) => model[name],
	)
	const failures = Arr.map(slots, (slot) => Option.getOrUndefined(Keyed.failureWithoutData(slot)))
	const first = failures[0]
	return first !== undefined &&
		Arr.every(failures, (failure) => failure !== undefined && isSameFailure(failure, first))
		? first
		: undefined
}

/** Presets a month or longer: widening from one of them would not help. */
const MONTH_OR_LONGER: ReadonlySet<string | undefined> = new Set([
	"30d",
	"1mo",
	"6w",
	"2mo",
	"3mo",
	"6mo",
	"12mo",
])

/** Google reported nothing at all for the window: totals, queries and pages are in, and all empty. */
const isQuietWindow = (model: Model): boolean =>
	dataOf(model.searchOverview)?.impressions === 0 &&
	dataOf(model.searchQueries)?.length === 0 &&
	dataOf(model.searchLanding)?.length === 0

/**
 * One explanation instead of four empty cards. Google's days arrive 2 to 3 days late, so a short
 * window carried over from another tab is the usual cause, and a month is the way out.
 */
const quietWindow = (h: H, model: Model): Html => {
	const isShort = model.search.startTime !== undefined || !MONTH_OR_LONGER.has(model.search.timePreset)
	return empty(h, [
		emptyHeader(h, [
			emptyMedia(h, { variant: "icon" }, [icon(h, "MagnifierIcon")]),
			emptyTitle(h, ["No search data in this window"]),
			emptyDescription(h, [
				isShort
					? "Google's numbers arrive 2 to 3 days late, so a short or recent window can be empty."
					: "Google reported no impressions for this property in this window.",
			]),
		]),
		...(isShort
			? [
					emptyContent(h, [
						emptyActions(h, [
							button(
								h,
								{
									variant: "outline",
									size: "sm",
									attributes: [h.OnClick(Message.ClickedWidenSearchRange())],
								},
								["Show the last month"],
							),
						]),
					]),
				]
			: []),
	])
}

const content = (h: H, model: Model, isNarrow: boolean, isComparable: boolean): ReadonlyArray<Html> => {
	const points = dataOf(model.searchTimeseries) ?? []
	if (isQuietWindow(model)) return [quietWindow(h, model)]
	const shared = sharedFailure(model)
	if (shared !== undefined)
		return [
			errorState(h, {
				failure: shared,
				title: "Couldn't load search data",
				onRetry: Message.ClickedRetrySearch(),
			}),
		]
	return [
		AsyncData.matchData(model.searchOverview.data, {
			onEmpty: () =>
				metricGrid(
					h,
					{ isBusy: true },
					Arr.map(SEARCH_METRICS, () => statRailItemSkeleton(h, METRIC_TILE.className)),
				),
			onFailure: (failure) =>
				errorState(h, {
					failure,
					variant: "row",
					title: "Couldn't load search totals",
					onRetry: Message.ClickedRetrySearch(),
				}),
			onData: (overview) => kpis(h, model, overview, points, isComparable),
		}),
		...Arr.filter([trend(h, model, points, isNarrow)], (node): node is Html => node !== null),
		tableCard(h, model, model.searchQueries, () => QUERIES),
		tableCard(h, model, model.searchLanding, (rows) => pagesSpec(model, rows)),
	]
}

export const searchTab = (h: H, model: Model, isNarrow: boolean): Html =>
	AsyncData.matchData(model.searchStatus.data, {
		onEmpty: () => skeleton(h, "h-64 w-full"),
		onFailure: (failure) =>
			errorState(h, {
				failure,
				title: "Couldn't load Search Console",
				onRetry: Message.ClickedRetrySearch(),
			}),
		onData: (status) => {
			const site = searchSiteOf(model.search, status)
			if (site === undefined) return notConnected(h, status)
			if (site.watermarkDate === null)
				return site.lastError === null ? importing(h) : importError(h, site.lastError, true)
			const today = pacificToday(model.nowMs)
			const through = completeThrough(site.watermarkDate, today)
			const coverage =
				model.window === null
					? undefined
					: searchConsoleCoverage(
							{ ...model.window, completeThrough: through },
							site.backfillDate,
							today,
						)
			const isComparable = coverage === undefined || (coverage.current && coverage.previous)
			return vstack(h, { gap: "4" }, [
				propertyHeading(h, status, site, through),
				...(site.lastError === null ? [] : [importError(h, site.lastError, false)]),
				...(isComparable ? [] : [historyImporting(h, site.backfillDate)]),
				...content(h, model, isNarrow, isComparable),
			])
		},
	})
