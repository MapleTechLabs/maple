import { EMPTY_VALUE, formatNumber, formatPercent } from "@maple/ui/lib/format"
import { Option, Array as Arr, String as Str } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../route"
import { alert, alertDescription, alertTitle } from "@maple/views/ui/alert"
import { linkButton } from "@maple/views/ui/button"
import { delta } from "@maple/views/ui/delta"
import {
	empty,
	emptyContent,
	emptyDescription,
	emptyHeader,
	emptyMedia,
	emptyTitle,
} from "@maple/views/ui/empty"
import { errorState } from "@maple/views/ui/error-state"
import { icon } from "@maple/views/ui/icon"
import { nativeOption, nativeSelect } from "@maple/views/ui/native-select"
import { panel, panelHeader } from "@maple/views/ui/panel"
import { emptyActions } from "@maple/views/ui/signal-empty-state"
import { skeleton } from "@maple/views/ui/skeleton"
import { hstack, vstack } from "@maple/views/ui/stack"
import {
	ariaSort,
	numericTableCell,
	sortButton,
	table,
	tableBody,
	tableHead,
	tableHeader,
	tableRow,
	truncatedTableCell,
} from "@maple/views/ui/table"
import { typography } from "@maple/views/ui/typography"
import { grid } from "@maple/views/ui/grid"
import { sectionHeading } from "../kit/section-heading"
import { sortRows } from "../kit/table-sort"
import { statRail, statRailItem } from "../kit/stat-rail"
import { Message } from "./message"
import type {
	Model,
	SearchLandingRow,
	SearchOverview,
	SearchSort,
	SearchSortKey,
	SearchStatus,
	SearchTable,
} from "./model"
import { filtersOf, searchSiteOf } from "./requests"
import { searchSortOf } from "./update"
import { searchTrendChart } from "./view-search-chart"
import type * as Keyed from "@maple/views/data/keyed"
import type { LoadFailure } from "@maple/views/data/load-failure"

// The Search tab: Google Search Console performance for one property, beside Maple's own
// sessions on the same landing pages.

type H = HtmlBuilder<Message>
type Metrics = Readonly<{ clicks: number; impressions: number; ctr: number; position: number }>

const dataOf = <A>(slot: { readonly data: AsyncData.AsyncData<A, unknown> }): A | undefined =>
	Option.getOrUndefined(AsyncData.getData(slot.data))

const formatPosition = (value: number): string => (value > 0 ? value.toFixed(1) : EMPTY_VALUE)

const integrationsHref = hrefOf(AppRoute.Integrations({ search: { integration: "google-search-console" } }))

/** `sc-domain:acme.dev` reads as the domain; a URL-prefix property as its URL. */
export const siteLabel = (siteUrl: string): string =>
	Str.startsWith("sc-domain:")(siteUrl) ? Str.slice("sc-domain:".length)(siteUrl) : siteUrl

const onRamp = (h: H, options: Readonly<{ title: string; description: string; action: string }>): Html =>
	empty(h, [
		emptyHeader(h, [
			emptyMedia(h, { variant: "icon" }, [icon(h, "MagnifierIcon")]),
			emptyTitle(h, [options.title]),
			emptyDescription(h, [options.description]),
		]),
		emptyContent(h, [
			emptyActions(h, [
				linkButton(h, { variant: "default", size: "sm", href: integrationsHref }, [options.action]),
			]),
		]),
	])

const notConnected = (h: H, status: SearchStatus): Html =>
	status.revoked
		? onRamp(h, {
				title: "Reconnect Google Search Console",
				description:
					"Google stopped accepting Maple's access to Search Console. Reconnect to keep importing clicks and impressions.",
				action: "Reconnect Search Console",
			})
		: status.connected
			? onRamp(h, {
					title: "Pick a Search Console property",
					description:
						"Search Console is connected, but no property is selected. Choose the sites to import.",
					action: "Choose properties",
				})
			: onRamp(h, {
					title: "No search data yet",
					description:
						"Connect Google Search Console to see the queries people search before they land on your site, and how those visits behave once they arrive.",
					action: "Connect Search Console",
				})

const importing = (h: H): Html =>
	empty(h, [
		emptyHeader(h, [
			emptyMedia(h, { variant: "icon" }, [icon(h, "ClockIcon")]),
			emptyTitle(h, ["Importing from Search Console"]),
			emptyDescription(h, [
				"The first import brings in the last two weeks and lands within about 15 minutes. Older days fill in after that.",
			]),
		]),
	])

const importError = (h: H, message: string, isBlocking: boolean): Html =>
	alert(h, { variant: isBlocking ? "crit" : "warn", size: "sm" }, [
		icon(h, "AlertWarningIcon"),
		alertTitle(h, [isBlocking ? "Couldn't import from Search Console" : "The latest import failed"]),
		alertDescription(h, [message]),
	])

const sitePicker = (h: H, status: SearchStatus, current: string): ReadonlyArray<Html> => {
	const enabled = Arr.filter(status.sites, (site) => site.enabled)
	if (enabled.length < 2) return []
	return [
		nativeSelect(
			h,
			{
				size: "sm",
				defaultValue: current,
				attributes: [
					h.AriaLabel("Search Console property"),
					h.OnChange((siteUrl) => Message.PickedSearchSite({ siteUrl })),
				],
			},
			Arr.map(enabled, (site) => nativeOption(site.siteUrl, siteLabel(site.siteUrl))),
		),
	]
}

/** Change against the previous period; position is inverted, since a lower one is better. */
const kpis = (h: H, overview: SearchOverview | undefined, spark: ReadonlyArray<Metrics>): Html => {
	const item = (
		eyebrow: string,
		pick: (metrics: Metrics) => number,
		format: (value: number) => string,
		options: Readonly<{ invert?: boolean; subline?: string }> = {},
	) =>
		statRailItem(h, {
			eyebrow,
			value: overview === undefined ? EMPTY_VALUE : format(pick(overview)),
			spark: Arr.map(spark, pick),
			delta:
				overview === undefined || pick(overview.previous) === 0
					? undefined
					: delta(h, {
							current: pick(overview),
							previous: pick(overview.previous),
							invert: options.invert,
						}),
			subline: options.subline,
		})
	return statRail(h, {}, [
		item("Clicks", (m) => m.clicks, formatNumber),
		item("Impressions", (m) => m.impressions, formatNumber),
		item("CTR", (m) => m.ctr, formatPercent),
		item("Avg position", (m) => m.position, formatPosition, { invert: true, subline: "Lower is better" }),
	])
}

type Column<Row> = Readonly<{
	key: SearchSortKey
	label: string
	value: (row: Row) => number | string
	cell: (row: Row) => string
}>

const metricColumns = <Row extends Metrics>(): ReadonlyArray<Column<Row>> => [
	{ key: "clicks", label: "Clicks", value: (row) => row.clicks, cell: (row) => formatNumber(row.clicks) },
	{
		key: "impressions",
		label: "Impressions",
		value: (row) => row.impressions,
		cell: (row) => formatNumber(row.impressions),
	},
	{ key: "ctr", label: "CTR", value: (row) => row.ctr, cell: (row) => formatPercent(row.ctr) },
	{
		key: "position",
		label: "Position",
		value: (row) => row.position,
		cell: (row) => formatPosition(row.position),
	},
]

/** One sortable table of the tab: a name column, the four search metrics, then any extras. */
const searchTable = <Row extends Metrics>(
	h: H,
	options: Readonly<{
		table: SearchTable
		label: string
		sort: SearchSort
		name: (row: Row) => string
		nameCell: (row: Row) => Html | string
		extra?: ReadonlyArray<Readonly<{ label: string; cell: (row: Row) => string }>>
		key: (row: Row) => string
	}>,
	rows: ReadonlyArray<Row>,
): Html => {
	const columns = metricColumns<Row>()
	const read = (row: Row, key: string): number | string =>
		key === "name"
			? options.name(row)
			: Option.getOrElse(
					Option.map(
						Arr.findFirst(columns, (column) => column.key === key),
						(column) => column.value(row),
					),
					() => 0,
				)
	const head = (key: SearchSortKey, label: string, align: "left" | "right") => {
		const isActive = options.sort.key === key
		return tableHead(
			h,
			[
				sortButton(
					h,
					{
						isActive,
						direction: options.sort.dir,
						align,
						onClick: Message.ClickedSearchSort({ table: options.table, key }),
					},
					[label],
				),
			],
			align === "right" ? "text-right" : undefined,
			ariaSort(h, isActive, options.sort.dir),
		)
	}
	return table(h, { size: "sm", variant: "bare", ariaLabel: options.label }, [
		tableHeader(h, [
			tableRow(h, [
				head("name", options.label, "left"),
				...Arr.map(columns, (column) => head(column.key, column.label, "right")),
				...Arr.map(options.extra ?? [], (column) => tableHead(h, [column.label], "text-right")),
			]),
		]),
		tableBody(
			h,
			Arr.map(sortRows(rows, options.sort, read), (row) =>
				tableRow(
					h,
					[
						truncatedTableCell(h, [options.nameCell(row)]),
						...Arr.map(columns, (column) => numericTableCell(h, [column.cell(row)])),
						...Arr.map(options.extra ?? [], (column) => numericTableCell(h, [column.cell(row)])),
					],
					undefined,
					[h.Key(options.key(row))],
				),
			),
		),
	])
}

const tablePanel = (h: H, title: string, hint: string | undefined, body: Html): Html =>
	panel(h, {}, [
		panelHeader(h, {
			title,
			action: hint === undefined ? undefined : typography(h, { size: "2xs", tone: "subtle" }, [hint]),
		}),
		body,
	])

const tableEmpty = (h: H, message: string): Html =>
	typography(h, { size: "xs", tone: "muted", as: "p", className: "px-4 py-6 text-center" }, [message])

/** A read's slot as a panel body: skeleton, failure with retry, empty line, or the table. */
const slotBody = <A>(
	h: H,
	slot: Keyed.Keyed<ReadonlyArray<A>, LoadFailure>,
	options: Readonly<{ what: string; empty: string; render: (rows: ReadonlyArray<A>) => Html }>,
): Html =>
	AsyncData.matchData(slot.data, {
		onEmpty: () => skeleton(h, "m-4 h-40"),
		onFailure: (failure) =>
			errorState(h, {
				failure,
				title: `Couldn't load ${options.what}`,
				onRetry: Message.ClickedRetrySearch(),
			}),
		onData: (rows) => (rows.length === 0 ? tableEmpty(h, options.empty) : options.render(rows)),
	})

const pathCell = (h: H, path: string, host: string | undefined): Html =>
	vstack(h, { gap: "0", shrink: true }, [
		typography(h, { size: "xs", mono: true, truncate: true, attributes: [h.Title(path)] }, [path]),
		...(host === undefined
			? []
			: [typography(h, { size: "2xs", tone: "subtle", truncate: true }, [host])]),
	])

/** A page URL as its path, with the host under it when the property spans several. */
const urlParts = (url: string): Readonly<{ host: string; path: string }> => {
	const match = /^https?:\/\/([^/?#]+)(.*)$/i.exec(url)
	return match === null ? { host: "", path: url } : { host: match[1] ?? "", path: match[2] || "/" }
}

const landingTable = (h: H, model: Model, rows: ReadonlyArray<SearchLandingRow>, isMultiHost: boolean) => {
	const hasConversions = Arr.some(rows, (row) => row.conversions !== null)
	return searchTable(
		h,
		{
			table: "landing",
			label: "Landing page",
			sort: searchSortOf(model, "landing"),
			name: (row) => row.path,
			nameCell: (row) => pathCell(h, row.path, isMultiHost ? row.host : undefined),
			key: (row) => `${row.host}${row.path}`,
			extra: [
				{ label: "Sessions", cell: (row) => formatNumber(row.sessions) },
				{
					label: "Bounce rate",
					cell: (row) => (row.bounceRate === null ? EMPTY_VALUE : formatPercent(row.bounceRate)),
				},
				...(hasConversions
					? [
							{
								label: "Conversions",
								cell: (row: SearchLandingRow) =>
									row.conversions === null ? EMPTY_VALUE : formatNumber(row.conversions),
							},
						]
					: []),
			],
		},
		rows,
	)
}

const content = (h: H, model: Model, isNarrow: boolean): ReadonlyArray<Html> => {
	const overview = dataOf(model.searchOverview)
	const points = dataOf(model.searchTimeseries) ?? []
	const pages = dataOf(model.searchPages) ?? []
	const isMultiHost = new Set(Arr.map(pages, (row) => urlParts(row.page).host)).size > 1
	const eventName = filtersOf(model.search).eventName
	return [
		AsyncData.matchData(model.searchOverview.data, {
			onEmpty: () => kpis(h, undefined, []),
			onFailure: (failure) =>
				errorState(h, {
					failure,
					title: "Couldn't load search totals",
					onRetry: Message.ClickedRetrySearch(),
				}),
			onData: () => kpis(h, overview, points),
		}),
		...(model.themeColors === null
			? []
			: [
					h.submodel({
						slotId: "analytics-search-chart",
						model: model.chart,
						view: searchTrendChart,
						viewInputs: { points, theme: model.themeColors, isNarrow },
						toParentMessage: (message) => Message.GotChartMessage({ message }),
					}),
				]),
		grid(h, { cols: 1, lg: 2, gap: "4", className: "items-start" }, [
			tablePanel(
				h,
				"Top queries",
				"Google leaves out rare queries",
				slotBody(h, model.searchQueries, {
					what: "search queries",
					empty: "No queries in this window",
					render: (rows) =>
						searchTable(
							h,
							{
								table: "queries",
								label: "Query",
								sort: searchSortOf(model, "queries"),
								name: (row) => row.query,
								nameCell: (row) => typography(h, { size: "xs", truncate: true }, [row.query]),
								key: (row) => row.query,
							},
							rows,
						),
				}),
			),
			tablePanel(
				h,
				"Top pages",
				undefined,
				slotBody(h, model.searchPages, {
					what: "search pages",
					empty: "No pages in this window",
					render: (rows) =>
						searchTable(
							h,
							{
								table: "pages",
								label: "Page",
								sort: searchSortOf(model, "pages"),
								name: (row) => urlParts(row.page).path,
								nameCell: (row) => {
									const parts = urlParts(row.page)
									return pathCell(h, parts.path, isMultiHost ? parts.host : undefined)
								},
								key: (row) => row.page,
							},
							rows,
						),
				}),
			),
		]),
		tablePanel(
			h,
			"Landing pages",
			eventName === undefined
				? "Filter by an event to count it as a conversion"
				: `Conversions are sessions that fired ${eventName}`,
			slotBody(h, model.searchLanding, {
				what: "landing pages",
				empty: "No landing pages in this window",
				render: (rows) => landingTable(h, model, rows, isMultiHost),
			}),
		),
	]
}

/** `/analytics?tab=search`. */
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
			return vstack(h, { gap: "6" }, [
				sectionHeading(h, {
					title: siteLabel(site.siteUrl),
					hint: "Search Console data arrives 2 to 3 days late",
					actions: hstack(h, { gap: "2" }, sitePicker(h, status, site.siteUrl)),
				}),
				...(site.lastError === null ? [] : [importError(h, site.lastError, false)]),
				...content(h, model, isNarrow),
			])
		},
	})
