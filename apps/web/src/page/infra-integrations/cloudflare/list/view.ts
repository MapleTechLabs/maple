import {
	CLOUDFLARE_VIEWS,
	type CloudflareView,
	CPU_HEAVY_P99_MS,
	MIN_RATED_REQUESTS,
	sortWorkersByAttention,
	WORKER_SCOPES,
	type WorkerListRow,
	type WorkerScope,
	workerHealth,
	workerInScope,
	ZONE_SCOPES,
	type ZoneScope,
	zoneHealth,
	zoneInScope,
} from "../../../../components/infra/cloudflare/list-model"
import type { CloudflareAccount } from "../../../../components/infra/cloudflare/accounts"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { TONE_FILL } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { label } from "../../../../ui/label"
import { ResolveThemeColors } from "../../../../charts/theme-colors"
import { empty, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "../../../../ui/empty"
import { errorState } from "../../../../ui/error-state"
import { icon } from "../../../../ui/icon"
import { switchControl } from "../../../../ui/switch"
import type { PageViewInputs } from "../../../contract"
import { dashboardPage } from "../../../kit/dashboard-page"
import { docsLink } from "../../../kit/signal-empty-state"
import { FLEET_BAND_BOXED, fleetBand, fleetBandLoading } from "../../../infra/kit/fleet-band"
import { heroFieldChip } from "../../../infra/kit/hero-chip"
import { viewTabStrip } from "../../../infra/kit/view-tabs"
import { pageHero, pageHeroParts, searchToolbar, headerActions } from "../../../infra/kit/page-parts"
import { pageTime } from "../../kit/page-time"
import type { Status, ZoneRow } from "../data"
import { ingestBanner, ingestEmpty, needsPermissions } from "../ingest"
import { integrationConnectCta } from "../../kit/integration-empty"
import { CLOUDFLARE_ACCENT } from "../../../integrations/catalog"
import { AppRoute, hrefOf } from "../../../../route"
import {
	accountCounts,
	accountShares,
	accountsOf,
	isNoTraffic,
	isWaiting,
	type ListData,
	listDataOf,
	type ListScope,
	listScopeOf,
	phaseOf,
	statusOf,
} from "./derive"
import { Message, type Model } from "./model"
import { DEFAULT_PRESET, viewHref } from "./update"
import { accountHealthLine, accountMenu, accountsStrip } from "./view-accounts"
import { type SparkContext, queueTable, workerTable, zoneTable, zoneTableLoading } from "./view-tables"

// `CloudflarePage` and `CloudflareListPage`.

type H = HtmlBuilder<Message>

const VIEW_LABEL = { zones: "Zones", workers: "Workers", queues: "Queues" } as const satisfies Record<
	CloudflareView,
	string
>

export const THEME_TOKENS = ["--chart-2"]

const bandLoading = (h: H): Html => fleetBandLoading(h, 3, FLEET_BAND_BOXED)

const count = <T>(rows: ReadonlyArray<T>, keep: (row: T) => boolean) => rows.filter(keep).length

const scopeMessage = (scope: ZoneScope | WorkerScope | undefined) => Message.ClickedScope({ scope })

/** `CloudflareZoneBand`: counts over the unfiltered fleet. */
const zoneBand = (h: H, zones: ReadonlyArray<ZoneRow>, activeScope: ZoneScope | undefined): Html => {
	const serving5xx = count(zones, (z) => zoneHealth(z) === "serving5xx")
	const mostly4xx = count(zones, (z) => zoneHealth(z) === "mostly4xx")
	const lowVolume = count(zones, (z) => zoneHealth(z) === "lowVolume")
	return fleetBand<ZoneScope, Message>(h, {
		total: zones.length,
		noun: "zone",
		caption: "worst signal per zone",
		segments: [
			{
				key: "healthy",
				count: zones.length - serving5xx - mostly4xx - lowVolume,
				className: TONE_FILL.ok,
			},
			{ key: "mostly 4xx", count: mostly4xx, className: TONE_FILL.warn },
			{ key: "serving 5xx", count: serving5xx, className: TONE_FILL.crit },
			{ key: "low volume", count: lowVolume, className: TONE_FILL.neutral },
		],
		cells: [
			{
				scope: "serving5xx",
				label: "Serving 5xx",
				hint: "1% or more of requests",
				value: serving5xx,
				tone: "crit",
			},
			{
				scope: "mostly4xx",
				label: "Mostly 4xx",
				hint: "half or more of requests",
				value: mostly4xx,
				tone: "warn",
			},
			{
				scope: "lowVolume",
				label: "Low volume",
				hint: `under ${MIN_RATED_REQUESTS} requests, not rated`,
				value: lowVolume,
				tone: "neutral",
			},
		],
		activeScope,
		onScopeChange: scopeMessage,
		className: FLEET_BAND_BOXED,
	})
}

/** `CloudflareWorkerBand`. */
const workerBand = (h: H, rows: ReadonlyArray<WorkerListRow>, activeScope: WorkerScope | undefined): Html => {
	const erroring = count(rows, (r) => workerHealth(r) === "erroring")
	const slow = count(rows, (r) => workerHealth(r) === "slow")
	return fleetBand<WorkerScope, Message>(h, {
		total: rows.length,
		noun: "Worker",
		caption: "each Worker by its worst signal: errors, then p99 duration",
		segments: [
			{ key: "healthy", count: rows.length - erroring - slow, className: TONE_FILL.ok },
			{ key: "slow", count: slow, className: TONE_FILL.warn },
			{ key: "erroring", count: erroring, className: TONE_FILL.crit },
		],
		cells: [
			{
				scope: "erroring",
				label: "Erroring",
				hint: "1% or more of invocations or DO calls",
				value: erroring,
				tone: "crit",
			},
			{
				scope: "slow",
				label: "Slow",
				hint: "p99 duration of 1s or more",
				value: count(rows, (r) => workerInScope(r, "slow")),
				tone: "warn",
			},
			{
				scope: "cpuHeavy",
				label: "CPU heavy",
				hint: `CPU p99 of ${CPU_HEAVY_P99_MS}ms or more`,
				value: count(rows, (r) => workerInScope(r, "cpuHeavy")),
				tone: "neutral",
			},
		],
		activeScope,
		onScopeChange: scopeMessage,
		className: FLEET_BAND_BOXED,
	})
}

const matches = (query: string, ...fields: ReadonlyArray<string>) =>
	query === "" || fields.some((field) => field.toLowerCase().includes(query))

const busy = (h: H, waiting: boolean) => [
	h.Class(cn("space-y-4", refreshingClass(waiting))),
	...(waiting ? [h.AriaBusy(true)] : []),
]

const zonesView = (
	h: H,
	model: Model,
	zones: ReadonlyArray<ZoneRow>,
	data: ListData,
	scope: ListScope,
	spark: SparkContext,
): Html => {
	const query = model.search.q ?? ""
	const q = query.trim().toLowerCase()
	const zoneScope = ZONE_SCOPES.find((s) => s === model.search.scope)
	const filtered = zones.filter(
		(zone) => (zoneScope === undefined || zoneInScope(zone, zoneScope)) && matches(q, zone.zoneName),
	)
	return h.div(busy(h, isWaiting(model.zones.data)), [
		zoneBand(h, zones, zoneScope),
		searchToolbar(h, {
			id: "cloudflare-search",
			value: query,
			placeholder: "Filter zones…",
			onInput: (value) => Message.ChangedSearch({ value }),
			onClear: Message.ClickedClearSearch(),
			trailing:
				filtered.length === zones.length
					? `${zones.length} zones · by requests`
					: `${filtered.length} of ${zones.length} zones`,
		}),
		zoneTable(h, {
			zones: filtered,
			sparks: data.sparks,
			accounts: scope.showAccountColumn
				? new Map(
						[...scope.zoneAccount].map(([zone, id]) => [zone, scope.accountNames.get(id) ?? id]),
					)
				: undefined,
			sort: model.zoneSort,
			emptyMessage:
				filtered.length === zones.length ? undefined : "No zones match these filters",
			spark,
		}),
	])
}

const workersView = (h: H, model: Model, rows: ReadonlyArray<WorkerListRow>, scope: ListScope): Html => {
	const query = model.search.q ?? ""
	const q = query.trim().toLowerCase()
	const workerScope = WORKER_SCOPES.find((s) => s === model.search.scope)
	const showPreviews = model.search.previews ?? false
	const previews = rows.filter((row) => row.isPreview).length
	const filtered = sortWorkersByAttention(
		rows.filter(
			(row) =>
				(showPreviews || !row.isPreview) &&
				(workerScope === undefined || workerInScope(row, workerScope)) &&
				matches(q, row.scriptName),
		),
	)
	return h.div(busy(h, isWaiting(model.workers.data)), [
		workerBand(h, rows, workerScope),
		searchToolbar(h, {
			id: "cloudflare-search",
			value: query,
			placeholder: "Filter Workers…",
			onInput: (value) => Message.ChangedSearch({ value }),
			onClear: Message.ClickedClearSearch(),
			trailing:
				filtered.length === rows.length
					? `${rows.length} Workers · problems first`
					: `${filtered.length} of ${rows.length} · problems first`,
			children:
				previews > 0
					? [
							label(
								h,
								{ className: "flex text-xs font-normal text-muted-foreground sm:text-xs" },
								[
									...switchControl(h, {
										id: "cloudflare-previews",
										inputId: "cloudflare-previews-input",
										isChecked: showPreviews,
										onToggle: Message.ToggledPreviews(),
									}),
									`Show ${previews} preview ${previews === 1 ? "deploy" : "deploys"}`,
								],
							),
						]
					: [],
		}),
		workerTable(h, {
			rows: filtered,
			accounts: scope.showAccountColumn ? scope.accountNames : undefined,
			emptyMessage:
				filtered.length === 0 && rows.length > 0
					? "No Workers match these filters"
					: undefined,
		}),
	])
}

const TITLE = "Cloudflare"
const DESCRIPTION = "Traffic, errors and cache for your zones and Workers."

/** The title row's badge; the account switch appears once there is data to scope. */
type HeaderParts = Readonly<{ trailing?: Html; actions: ReadonlyArray<Html> }>

const header = (
	h: H,
	model: Model,
	singleAccountName: string | null,
	scope: ListScope | null,
): HeaderParts => {
	if (scope === null) return { actions: [] }
	const account = scope.multiAccount
		? accountMenu(h, model.accountMenu, scope.accounts, scope.accountId)
		: singleAccountName
			? heroFieldChip(h, { label: "account", value: singleAccountName })
			: undefined
	return { trailing: account, actions: [] }
}

/** The view tabs for the header's `tabs` slot, each with its count; empty views stay hidden. */
const viewTabs = (h: H, model: Model, scope: ListScope, inPlace: boolean): Html | undefined => {
	const views = CLOUDFLARE_VIEWS.filter((v) => v === scope.view || scope.counts[v] !== 0)
	if (views.length < 2) return undefined
	return viewTabStrip(
		h,
		"Cloudflare views",
		views.map((v) => ({
			id: v,
			title: scope.counts[v] === null ? VIEW_LABEL[v] : `${VIEW_LABEL[v]} ${scope.counts[v]}`,
			href: viewHref(model.search, v),
			onClick: inPlace ? Message.ClickedView({ view: v }) : undefined,
		})),
		scope.view,
	)
}

/** `CloudflareListPage`'s props: what the route reads, or the lab's fixtures. */
export type ListFrame = Readonly<{
	data: ListData
	accounts: ReadonlyArray<CloudflareAccount>
	singleAccountName: string | null
	banner: Html | null
	/** The lab has no router: its view tabs switch on a plain click instead of following the link. */
	inPlaceViews?: boolean
}>

const listPage = (h: H, model: Model, status: Status, data: ListData, spark: SparkContext): Html => {
	const phase = phaseOf(model)
	return listBody(
		h,
		model,
		{
			data,
			accounts: accountsOf(model),
			singleAccountName: status.accountName,
			banner: phase === null ? null : ingestBanner(h, phase),
		},
		spark,
		false,
	)
}

/** `CloudflareListPage`: header, banner, accounts strip and the current view. The route draws the header in its title row. */
export const listBody = (
	h: H,
	model: Model,
	frame: ListFrame,
	spark: SparkContext,
	withHeader = true,
): Html => {
	const { data, banner } = frame
	const scope = listScopeOf(model, data, frame.accounts)
	const healthLine = scope.scopedAccount === undefined ? null : accountHealthLine(h, scope.scopedAccount)
	const body =
		scope.view === "zones"
			? scope.zones === null
				? h.div([h.Class("space-y-4")], [bandLoading(h), zoneTableLoading(h)])
				: zonesView(h, model, scope.zones, data, scope, spark)
			: scope.view === "workers"
				? scope.workerRows === null
					? bandLoading(h)
					: workersView(h, model, scope.workerRows, scope)
				: queueTable(h, {
						queues: scope.queues ?? [],
						sort: model.queueSort,
						isWaiting: isWaiting(model.platform.data),
					})
	const content = [
		...(banner === null ? [] : [banner]),
		...(scope.showAccountColumn
			? [
					accountsStrip(
						h,
						scope.accounts,
						accountShares(scope.view, data, scope.zoneAccount),
						accountCounts(scope.accounts, data, scope.zoneAccount),
					),
				]
			: healthLine === null
				? []
				: [healthLine]),
		body,
	]
	return h.div(
		[h.Class("space-y-6")],
		[
			...(withHeader
				? [pageHero(h, { title: TITLE, ...header(h, model, frame.singleAccountName, scope) })]
				: []),
			...content,
		],
	)
}

const noTraffic = (h: H): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [icon(h, "CloudflareBrandIcon", { size: 16 })]),
				emptyTitle(h, ["No Cloudflare traffic in this window"]),
				emptyDescription(h, [
					"No zone, Worker or queue reported anything over the selected range. Widen the time range, or check back once more traffic has been collected.",
				]),
			]),
			docsLink(h, "cloudflare"),
		],
		"py-16",
	)

const dataView = (h: H, model: Model, status: Status, spark: SparkContext): Html => {
	const data = listDataOf(model)
	if (isNoTraffic(data)) {
		// A connection that has never produced anything says why; a quiet window offers a wider one.
		const phase = phaseOf(model)
		if (phase !== null && phase.kind !== "live" && phase.kind !== "backfilling")
			return ingestEmpty(h, phase)
		return noTraffic(h)
	}
	return listPage(h, model, status, data, spark)
}

const FEATURES = [
	{
		label: "Zone analytics",
		title: "Requests and cache per zone",
		description: "Traffic, cache hit rate and errors for every zone.",
	},
	{
		label: "Workers",
		title: "Scripts on the service map",
		description: "Every Worker appears as a node with request volume and errors next to your traces.",
	},
	{
		label: "DNS and security",
		title: "Firewall events with context",
		description: "DNS queries and WAF activity land alongside your traces and logs.",
	},
]

/** Nothing connected: what this page will show, and the way to the connect flow. */
const cloudflareConnectCta = (h: H): Html =>
	integrationConnectCta(h, {
		brand: { icon: "CloudflareBrandIcon", backerIcon: "CloudflareMonoIcon", accent: CLOUDFLARE_ACCENT },
		features: FEATURES,
		hint: "Read-only. Your zones and Workers appear here within about 15 minutes of connecting.",
		label: "Connect Cloudflare",
		href: hrefOf(AppRoute.SourcesNew({ search: { integration: "cloudflare" } })),
	})

const connectedView = (h: H, model: Model, status: Status, spark: SparkContext): Html => {
	if (!status.connected) return cloudflareConnectCta(h)
	if (!status.analyticsCapable) return needsPermissions(h)
	return dataView(h, model, status, spark)
}

const statusView = (h: H, model: Model, spark: SparkContext): Html =>
	AsyncData.match(model.status.data, {
		onIdle: () => bandLoading(h),
		onLoading: () => bandLoading(h),
		onFailure: (failure) => errorState(h, { failure }),
		onStale: ({ error }) => errorState(h, { failure: error }),
		onSuccess: (status) => connectedView(h, model, status, spark),
		onRefreshing: (status) => connectedView(h, model, status, spark),
	})

/** The title row the route and the lab share: title, account chip and description, time controls, view tabs. */
export const titleRow = (
	h: H,
	model: Model,
	singleAccountName: string | null,
	scope: ListScope | null,
	inPlaceViews = false,
): Readonly<{ titleContent: Html; actions: Html; tabs: Html | undefined }> => {
	const hero = header(h, model, singleAccountName, scope)
	const timeControls = pageTime(h, {
		search: model.search,
		defaultPreset: DEFAULT_PRESET,
		window: model.window,
		picker: model.timePicker,
		toPickerMessage: (message) => Message.GotTimePickerMessage({ message }),
		onReset: Message.ClickedResetTimeRange(),
		onReload: Message.ClickedReload(),
		isReloading: model.isReloading,
	})
	return {
		titleContent: pageHeroParts(h, {
			title: TITLE,
			trailing: hero.trailing,
			description: DESCRIPTION,
		}).title,
		actions: headerActions(h, hero.actions, timeControls),
		tabs: scope === null ? undefined : viewTabs(h, model, scope, inPlaceViews),
	}
}

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, _inputs, h) => {
	const spark = { theme: model.themeColors, isChartReady: model.chartRuntime._tag === "Ready" }
	const status = statusOf(model)
	const data = listDataOf(model)
	const hasData = status !== null && status.connected && status.analyticsCapable && !isNoTraffic(data)
	const row = titleRow(h, model, status?.accountName ?? null, hasData ? listScopeOf(model, data) : null)
	return h.div(
		[h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: THEME_TOKENS }))],
		[dashboardPage(h, { gap: "lg", ...row }, [statusView(h, model, spark)])],
	)
})
