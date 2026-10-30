import {
	GCP_DATABASE_RULES,
	GCP_SERVICE_RULES,
	GCP_SUBSCRIPTION_RULES,
	GCP_WORKLOAD_RULES,
	gcpProjectCounts,
	gcpProjectHealth,
	gcpProjectShares,
	gcpListRows,
	gcpListScope,
	gcpViewFailed,
	sortByAttention,
	type GcpFleetRead,
	type GcpProjectHealth,
	type GcpSparks,
	type RowRules,
} from "../../../../components/infra/gcp/list-model"
import type { GcpCloudSqlInstance } from "../../../../components/infra/gcp/inventory"
import {
	GCP_RESOURCES_TAB,
	GCP_VIEW_SERVICES,
	gcpResourcesError,
	type GcpServiceView,
	type GcpView,
} from "../../../../components/infra/gcp/tabs"
import { formatPercentColumn, pluralize } from "@maple/ui/lib/format"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html } from "foldkit/html"
import { ResolveThemeColors, type ThemeColors } from "../../../../charts/theme-colors"
import { button } from "../../../../ui/button"
import { errorState } from "../../../../ui/error-state"
import { icon } from "../../../../ui/icon"
import type * as Menu from "../../../../ui/menu"
import { skeleton } from "../../../../ui/skeleton"
import { statusDot } from "../../../../ui/status-dot"
import type { PageViewInputs } from "../../../contract"
import { dashboardPage } from "../../../kit/dashboard-page"
import { integrationNotConnected } from "../../kit/empty-states"
import { integrationConnectCta } from "../../kit/integration-empty"
import { AppRoute, hrefOf } from "../../../../route"
import { GCP_ACCENT } from "../../../integrations/catalog"
import { heroFieldChip } from "../../../infra/kit/hero-chip"
import { viewTabStrip } from "../../../infra/kit/view-tabs"
import { pageHeroParts, searchToolbar, headerActions } from "../../../infra/kit/page-parts"
import type * as TimeRangePicker from "../../../kit/time-range-picker"
import { pageTime } from "../../kit/page-time"
import {
	cloudSqlInstancesOf,
	metricsConnectors,
	noticeOf,
	pageStateOf,
	requestedViewOf,
	sparksOf,
	windowSecondsOf,
	statusOf,
} from "./derive"
import { Message, type Model } from "./model"
import { DEFAULT_PRESET, viewHref } from "./update"
import {
	GCP_DATABASE_BAND,
	GCP_SERVICE_BAND,
	GCP_SUBSCRIPTION_BAND,
	type GcpBandSpec,
	gcpBand,
	gcpBandLoading,
	gcpWorkloadBand,
} from "./view-band"
import { gcpNotice } from "./view-notice"
import { resourcesView } from "./view-resources"
import { projectMenu } from "./view-project-menu"
import type { H, RowsContext, TimeSearch } from "./view-rows"
import {
	databasesTable,
	serviceTable,
	serviceTableLoading,
	servicesTable,
	subscriptionsTable,
} from "./view-tables"

// `GcpPage`, `GcpInfra` and `GcpListPage`. `gcpListPageParts` and `titleRow` are what the lab reuses.

const VIEW_LABEL = {
	services: "Services",
	pubsub: "Pub/Sub",
	cloudSql: "Cloud SQL",
	gke: "GKE",
	computeEngine: "Compute Engine",
	loadBalancing: "Load Balancing",
	resources: "Resources",
} as const satisfies Record<GcpView, string>

const ROWS_NOUN = {
	services: "services",
	pubsub: "subscriptions",
	cloudSql: "instances",
	gke: "containers",
	computeEngine: "VMs",
	loadBalancing: "URL maps",
} as const

const GENERIC_BAND = {
	gke: gcpWorkloadBand("container"),
	computeEngine: gcpWorkloadBand("VM"),
	loadBalancing: gcpWorkloadBand("URL map"),
} as const

export const THEME_TOKENS = ["--chart-2", "--severity-error", "--muted-foreground"]

const TITLE = "Google Cloud"

/** What the page's title row carries: the badge beside the title, the controls before the time picker. */
type HeaderParts = Readonly<{ description?: string; trailing?: Html; actions: ReadonlyArray<Html> }>

const intro: HeaderParts = {
	description:
		"Workloads and resources of your connected Google Cloud projects, from Cloud Monitoring metrics and Cloud Asset Inventory.",
	actions: [],
}

/** "3 projects · Services, Pub/Sub · metrics every 5 minutes", once projects load. */
const loadedDescription = (
	projects: ReadonlyArray<string>,
	views: ReadonlyArray<GcpView>,
): string | undefined => {
	if (projects.length === 0) return intro.description
	const kinds = views.filter((option) => option !== GCP_RESOURCES_TAB).map((option) => VIEW_LABEL[option])
	return [
		`${projects.length} ${pluralize(projects.length, "project")}`,
		...(kinds.length === 0 ? [] : [kinds.join(", ")]),
		"metrics every 5 minutes",
	].join(" · ")
}

/** `tabs` goes to the header's `tabs` slot, pinned under the title row. */
export type PageParts = Readonly<{
	header: HeaderParts
	tabs?: Html
	body: ReadonlyArray<Html>
	/** The body is a failure card with Try again, so the header drops Reload. */
	isFailed?: boolean
}>

/** `ListBody`: one view's band, search and table; the band counts every row, the table what is left. */
const listBody = <R extends { readonly keys: ReadonlyArray<string> }, S extends string>(
	h: H,
	state: ListState,
	options: Readonly<{
		rows: ReadonlyArray<R>
		rules: RowRules<R, S>
		spec: GcpBandSpec<S>
		region: string | undefined
		noun: string
		order?: string
		title: string
		failed: boolean
		render: (rows: ReadonlyArray<R>, emptyMessage: string) => Html
	}>,
): ReadonlyArray<Html> => {
	const { rows, rules } = options
	const scope = rules.scopes.find((candidate) => candidate === state.scope)
	const query = state.q ?? ""
	const needle = query.trim().toLowerCase()
	const shown = sortByAttention(
		rules,
		rows.filter(
			(row) =>
				(scope === undefined || rules.inScope(row, scope)) &&
				(needle === "" || row.keys.join(" ").toLowerCase().includes(needle)),
		),
	)
	const emptyMessage = options.failed
		? `Maple could not read the ${options.title} metrics. Reload to try again.`
		: rows.length === 0
			? `No ${options.title} metrics in this time range.`
			: `No ${options.noun} match. Clear the search or scope.`
	return [
		gcpBand(h, {
			rows,
			rules,
			spec: options.spec,
			activeScope: scope,
			onScopeChange: (next) => Message.ClickedScope({ scope: next }),
		}),
		searchToolbar(h, {
			id: "gcp-search",
			value: query,
			placeholder: `Filter ${options.noun}`,
			onInput: (value) => Message.ChangedSearch({ value }),
			onClear: Message.ClickedClearSearch(),
			trailing:
				shown.length === rows.length
					? `${rows.length} ${options.noun} · ${options.order ?? "problems first"}`
					: `${shown.length} of ${rows.length} ${options.noun}`,
			children: options.region === undefined ? [] : [regionChip(h, options.region)],
		}),
		options.render(shown, emptyMessage),
	]
}

/** `FilterChipRail` with the one region chip. */
const regionChip = (h: H, region: string): Html => {
	const label = `region ${region}`
	return h.div(
		[h.Class("flex flex-wrap items-center gap-1.5"), h.AriaLabel("Active filters")],
		[
			h.span(
				[
					h.Class(
						"inline-flex items-center gap-1 rounded-sm border border-border/60 bg-background/60 py-0.5 pr-0.5 pl-1.5 font-mono text-3xs text-muted-foreground",
					),
				],
				[
					h.span([h.Class("max-w-[22ch] truncate text-foreground/80")], [label]),
					button(
						h,
						{
							variant: "ghost",
							size: "icon-2xs",
							className: "text-muted-foreground hover:text-foreground",
							attributes: [
								h.AriaLabel(`Remove ${label}`),
								h.OnClick(Message.ClickedClearRegion()),
							],
						},
						[icon(h, "XmarkIcon")],
					),
				],
			),
			h.button(
				[
					h.Type("button"),
					h.OnClick(Message.ClickedClearRegion()),
					h.Class(
						"font-mono text-3xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline ml-1",
					),
				],
				["Clear all"],
			),
		],
	)
}

// The dot beside the name carries a warning; only a critical note keeps its colour in the text.
const healthText = (health: GcpProjectHealth | undefined) =>
	health?.tone === "crit" ? TONE_TEXT.crit : "text-muted-foreground"

// A project with no connector health still gets a dot, neutral, so every name lines up.
const healthDotOf = (h: H, health: GcpProjectHealth | undefined): ReadonlyArray<Html> => [
	statusDot(h, { tone: health?.tone ?? "neutral" }),
]

/** What a project's share counts, matching `gcpProjectShares`. */
const SHARE_UNIT = {
	services: "of requests",
	pubsub: "of messages",
	cloudSql: "of instances",
	gke: "of workloads",
	computeEngine: "of instances",
	loadBalancing: "of load balancers",
} as const satisfies Record<GcpServiceView, string>

/** `GcpProjectsStrip`: one cell per project, the biggest share first; a cell scopes to it. */
const projectsStrip = (
	h: H,
	projects: ReadonlyArray<string>,
	share: ReadonlyMap<string, number>,
	counts: (project: string) => string,
	health: ReadonlyMap<string, GcpProjectHealth>,
	shareUnit: string,
): Html =>
	h.div(
		[h.Class("flex flex-col overflow-hidden rounded-md border md:flex-row")],
		projects
			.toSorted((a, b) => (share.get(b) ?? 0) - (share.get(a) ?? 0))
			.map((project) => {
				const fraction = share.get(project) ?? 0
				const projectHealth = health.get(project)
				const problem = projectHealth !== undefined && projectHealth.tone !== "ok"
				return h.button(
					[
						h.Type("button"),
						h.OnClick(Message.SelectedProject({ project })),
						h.Class(
							"flex min-w-0 flex-1 flex-col gap-2 border-b px-4 py-3 text-left transition-colors last:border-0 hover:bg-muted/50 md:border-b-0 md:border-l md:first:border-l-0",
						),
					],
					[
						h.span(
							[h.Class("flex items-center gap-2")],
							[
								...healthDotOf(h, projectHealth),
								h.span(
									[h.Class("truncate font-mono text-xs font-medium text-foreground")],
									[project],
								),
								h.span(
									[h.Class("ml-auto flex items-baseline gap-1 whitespace-nowrap")],
									[
										h.span(
											[h.Class("font-mono text-2xs tabular-nums text-foreground")],
											[formatPercentColumn(fraction)],
										),
										h.span([h.Class("text-3xs text-muted-foreground")], [shareUnit]),
									],
								),
							],
						),
						h.span(
							[h.Class("block h-1 w-full overflow-hidden rounded-full bg-muted")],
							[
								h.span([
									h.Class("block h-full rounded-full bg-muted-foreground/60"),
									h.Style({
										width: `${Math.max(fraction * 100, fraction > 0 ? 1.5 : 0)}%`,
									}),
								]),
							],
						),
						h.span(
							[h.Class(cn("truncate font-mono text-3xs", healthText(projectHealth)))],
							[problem ? projectHealth.message : counts(project)],
						),
					],
				)
			}),
	)

const infraView = (h: H, model: Model, connectors: ReturnType<typeof metricsConnectors>): PageParts => {
	const fleetData = model.fleet.data
	const fleet = AsyncData.isSuccess(fleetData) || AsyncData.isRefreshing(fleetData) ? fleetData.data : null
	const collecting = connectors.length > 0
	if (connectors.length === 0 && fleet !== null && fleet.length === 0) {
		return {
			header: intro,
			body: [
				integrationNotConnected(h, {
					icon: icon(h, "GoogleCloudIcon", { size: 16 }),
					title: "Turn on metrics for Google Cloud",
					description:
						"Your Google Cloud connections forward logs only. Turn on Metrics and resources under Configure in the Google Cloud integration, then run the setup script.",
					integration: "gcp",
					actionLabel: "Open the integration",
					docsPage: "gcp",
				}),
			],
		}
	}
	const failures = Option.toArray(AsyncData.getError(fleetData))
	if (failures.length > 0) {
		return {
			header: intro,
			isFailed: true,
			body: failures.map((failure) =>
				errorState(h, {
					failure,
					title: "Couldn't load Google Cloud workloads",
					onRetry: Message.ClickedRetryFleet(),
				}),
			),
		}
	}
	const notice = noticeOf(model, connectors)
	return gcpListPageParts(h, {
		fleet,
		sparks: sparksOf(model),
		windowSeconds: windowSecondsOf(model),
		cloudSqlInstances: cloudSqlInstancesOf(model, collecting),
		projectHealth: gcpProjectHealth(connectors, model.nowMs),
		collecting,
		notice: notice === null ? [] : [gcpNotice(h, notice)],
		resources: (timeSearch) => resourcesView(h, model, timeSearch, gcpResourcesError(connectors)),
		state: { ...model.search, view: requestedViewOf(model) },
		timeSearch: {
			startTime: model.search.startTime,
			endTime: model.search.endTime,
			timePreset: model.search.timePreset,
		},
		theme: model.themeColors,
		isChartReady: model.chartRuntime._tag !== "Loading",
		isWaiting: AsyncData.isRefreshing(fleetData),
		projectMenu: model.projectMenu,
		locale: model.locale,
		viewTab: (view) => ({ href: viewHref(model.search, view) }),
	})
}

/** `GcpListState`: the route's search, or the lab's state. */
export type ListState = Readonly<{
	view?: GcpView | undefined
	q?: string | undefined
	scope?: string | undefined
	project?: string | undefined
	region?: string | undefined
}>

export type ListPageInput = Readonly<{
	/** Null while loading. */
	fleet: ReadonlyArray<GcpFleetRead> | null
	sparks: GcpSparks
	/** The seconds `fleet` was read over. */
	windowSeconds: number
	cloudSqlInstances: ReadonlyArray<GcpCloudSqlInstance> | undefined
	projectHealth: ReadonlyMap<string, GcpProjectHealth>
	collecting: boolean
	notice: ReadonlyArray<Html>
	resources: (timeSearch: TimeSearch) => Html
	state: ListState
	timeSearch: TimeSearch
	theme: ThemeColors | null
	isChartReady: boolean
	isWaiting: boolean
	projectMenu: Menu.Model
	/** `toLocaleString`'s locale for the counts. */
	locale: string
	/** A view tab's link; the lab adds an in-place click, the route links to its URL. */
	viewTab: (view: GcpView) => Readonly<{ href: string; onClick?: Message }>
}>

/** The title row's time controls: the route's search and picker, or the lab's. */
export type TitleRowTime = Readonly<{
	search: TimeSearch
	window: Readonly<{ startTime: string; endTime: string }> | null
	timePicker: TimeRangePicker.Model
	isReloading: boolean
}>

/** The title row the route and the lab share: title, project badge and description, then time controls. */
export const titleRow = (
	h: H,
	header: HeaderParts,
	time: TitleRowTime,
	isFailed = false,
): Readonly<{ titleContent: Html; actions: Html }> => ({
	titleContent: pageHeroParts(h, {
		title: TITLE,
		description: header.description,
		trailing: header.trailing,
	}).title,
	actions: headerActions(
		h,
		header.actions,
		pageTime(h, {
			search: time.search,
			defaultPreset: DEFAULT_PRESET,
			window: time.window,
			picker: time.timePicker,
			toPickerMessage: (message) => Message.GotTimePickerMessage({ message }),
			onReset: Message.ClickedResetTimeRange(),
			onReload: Message.ClickedReload(),
			isReloading: time.isReloading,
			isReloadHidden: isFailed,
		}),
	),
})

/** The header, then the projects strip and the current view's band, search and table. */
/** `GcpListPage`: the header, view tabs, then the projects strip and the current view. */
export const gcpListPageParts = (h: H, input: ListPageInput): PageParts => {
	const { fleet, state, isWaiting } = input
	const allRows =
		fleet === null ? null : gcpListRows(fleet, input.sparks, input.windowSeconds, input.cloudSqlInstances)
	const { projects, project, region, inRegion, rows, counts, views, view } = gcpListScope(
		allRows,
		{ view: state.view, project: state.project, region: state.region },
		input.collecting,
	)
	const multiProject = projects.length > 1
	const projectCounts = (name: string) => gcpProjectCounts(inRegion, name, view)
	const ctx: RowsContext = {
		timeSearch: input.timeSearch,
		showProject: multiProject && project === undefined,
		theme: input.theme,
		isChartReady: input.isChartReady,
		locale: input.locale,
	}
	const section = (children: ReadonlyArray<Html>) =>
		h.div(
			[h.Class(cn("space-y-4", refreshingClass(isWaiting))), ...(isWaiting ? [h.AriaBusy(true)] : [])],
			children,
		)
	const body = (): Html => {
		if (view === GCP_RESOURCES_TAB) return input.resources(ctx.timeSearch)
		if (fleet === null) {
			return section([
				gcpBandLoading(h),
				serviceTableLoading(h, GCP_VIEW_SERVICES[view][0] ?? "cloudRun"),
			])
		}
		const failed = gcpViewFailed(fleet, view)
		switch (view) {
			case "services":
				return section(
					listBody(h, state, {
						rows: rows.services,
						rules: GCP_SERVICE_RULES,
						spec: GCP_SERVICE_BAND,
						region,
						noun: ROWS_NOUN.services,
						title: "Cloud Run or Cloud Functions",
						failed,
						render: (shown, emptyMessage) => servicesTable(h, shown, emptyMessage, ctx),
					}),
				)
			case "pubsub":
				return section(
					listBody(h, state, {
						rows: rows.pubsub,
						rules: GCP_SUBSCRIPTION_RULES,
						spec: GCP_SUBSCRIPTION_BAND,
						region,
						noun: ROWS_NOUN.pubsub,
						title: "Pub/Sub",
						failed,
						render: (shown, emptyMessage) => subscriptionsTable(h, shown, emptyMessage, ctx),
					}),
				)
			case "cloudSql":
				return section(
					listBody(h, state, {
						rows: rows.cloudSql,
						rules: GCP_DATABASE_RULES,
						spec: GCP_DATABASE_BAND,
						region,
						noun: ROWS_NOUN.cloudSql,
						order: "closest to a limit first",
						title: "Cloud SQL",
						failed,
						render: (shown, emptyMessage) => databasesTable(h, shown, emptyMessage, ctx),
					}),
				)
			default:
				return section(
					listBody(h, state, {
						rows: rows[view],
						rules: GCP_WORKLOAD_RULES,
						spec: GENERIC_BAND[view],
						region,
						noun: ROWS_NOUN[view],
						title: VIEW_LABEL[view],
						failed,
						render: (shown, emptyMessage) =>
							serviceTable(h, view, shown, GENERIC_BAND[view], emptyMessage, ctx),
					}),
				)
		}
	}
	const health = input.projectHealth
	const tabs =
		views.length > 1
			? viewTabStrip(
					h,
					"Google Cloud views",
					views.map((option) => ({
						id: option,
						title:
							option === GCP_RESOURCES_TAB || counts === null
								? VIEW_LABEL[option]
								: `${VIEW_LABEL[option]} ${counts[option]}`,
						...input.viewTab(option),
					})),
					view,
				)
			: undefined
	return {
		header: {
			description: loadedDescription(projects, views),
			trailing: multiProject
				? projectMenu(h, {
						model: input.projectMenu,
						projects,
						counts: projectCounts,
						health,
						value: project,
					})
				: projects.length === 1
					? heroFieldChip(h, { label: "project", value: projects[0] ?? "" })
					: undefined,
			actions: [],
		},
		tabs,
		// One block: a bare `overflow-hidden` strip would shrink to nothing in the flex scroll area.
		body: [
			h.div(
				[h.Class("space-y-6")],
				[
					...input.notice,
					...(multiProject && project === undefined && view !== GCP_RESOURCES_TAB
						? [
								projectsStrip(
									h,
									projects,
									gcpProjectShares(inRegion, view),
									projectCounts,
									health,
									SHARE_UNIT[view],
								),
							]
						: []),
					body(),
				],
			),
		],
	}
}

const content = (h: H, model: Model): PageParts =>
	AsyncData.match(model.status.data, {
		onIdle: () => ({ header: intro, body: [skeleton(h, "h-64 w-full")] }),
		onLoading: () => ({ header: intro, body: [skeleton(h, "h-64 w-full")] }),
		onFailure: (failure) => ({
			header: intro,
			isFailed: true,
			body: [
				errorState(h, {
					failure,
					title: "Couldn't load the Google Cloud integration",
					onRetry: Message.ClickedRetryStatus(),
				}),
			],
		}),
		onStale: ({ error }) => ({
			header: intro,
			isFailed: true,
			body: [
				errorState(h, {
					failure: error,
					title: "Couldn't load the Google Cloud integration",
					onRetry: Message.ClickedRetryStatus(),
				}),
			],
		}),
		onRefreshing: () => connected(h, model),
		onSuccess: () => connected(h, model),
	})

/** Nothing connected: what this page will show, and the way to the connect flow. */
const gcpConnectCta = (h: H): Html =>
	integrationConnectCta(h, {
		brand: { icon: "GoogleCloudIcon", backerIcon: "GoogleCloudMonoIcon", accent: GCP_ACCENT },
		features: [
			{
				label: "Metrics",
				title: "Workloads, no agents",
				description: "Cloud Run, GKE, Compute Engine, Cloud SQL and more, read every 5 minutes.",
			},
			{
				label: "Resources",
				title: "Everything in the scope",
				description: "A project, a folder or the organization, including projects created later.",
			},
			{
				label: "Access",
				title: "Read-only, your choice of setup",
				description: "A Cloud Shell script, the console, Terraform or Alchemy. No keys for Maple.",
			},
		],
		hint: "Connect a project, folder or organization. Its workloads and resources appear here.",
		label: "Connect Google Cloud",
		href: hrefOf(AppRoute.SourcesNew({ search: { integration: "gcp" } })),
	})

const connected = (h: H, model: Model): PageParts => {
	const status = statusOf(model)
	if (status === null) return { header: intro, body: [] }
	const state = pageStateOf(status, model.nowMs)
	switch (state._tag) {
		case "NotConnected":
			return { header: intro, body: [gcpConnectCta(h)] }
		case "SetupPending":
			return {
				header: intro,
				body: [
					integrationNotConnected(h, {
						icon: icon(h, "GoogleCloudIcon", { size: 16 }),
						title: "Finish setting up Google Cloud",
						description: "Metrics and resources are on, but the setup script hasn't run yet.",
						integration: "gcp",
						actionLabel: "Open the integration",
						docsPage: "gcp",
					}),
				],
			}
		case "Infra":
			return infraView(h, model, state.connectors)
	}
}

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, _inputs, h) => {
	const page = content(h, model)
	return h.div(
		[h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: THEME_TOKENS }))],
		[
			dashboardPage(
				h,
				{
					scrollClassName: "gap-6",
					...titleRow(h, page.header, model, page.isFailed),
					tabs: page.tabs,
				},
				page.body,
			),
		],
	)
})
