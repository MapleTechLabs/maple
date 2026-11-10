import type { VercelInfraRequestBucket, VercelIntegrationStatus } from "@maple/domain/http"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { cn } from "@maple/ui/lib/utils"
import { Array as Arr, String as Str } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import {
	fillBuckets,
	vercelFleetTotals,
	vercelProjectRows,
	zeroRequestBucket,
} from "../../../../components/infra/vercel/list-model"
import type { TimeWindow } from "../../../../data/time-range"
import { AppRoute, hrefOf } from "../../../../route"
import { errorState } from "@maple/views/ui/error-state"
import { icon } from "@maple/views/ui/icon"
import type { PageViewInputs } from "../../../contract"
import { dashboardPage } from "../../../kit/dashboard-page"
import { filteredEmpty } from "@maple/views/ui/signal-empty-state"
import { heroChip } from "../../../infra/kit/hero-chip"
import { countLabel, pageHero, searchToolbar } from "../../../infra/kit/page-parts"
import { pickTimeSearch, type TimeSearch, viewTabStrip } from "../../../infra/kit/view-tabs"
import { dataTableEmpty, skeletonRows } from "../../../infra/kit/data-table"
import { skeleton } from "@maple/views/ui/skeleton"
import { integrationNotConnected } from "../../kit/empty-states"
import { pageTime } from "../../kit/page-time"
import { DEFAULT_PRESET, seriesInput } from "../data"
import {
	auditLogSection,
	buildsSection,
	drainNotice,
	readSection,
	speedInsightsSection,
	webAnalyticsSection,
} from "../sections"
import { aiGatewayProjectsTable, type Clock, dataOf, failureOf, fillAiSeries } from "../view-parts"
import { Message, type Model } from "./model"
import { isProjectsView } from "./update"
import {
	type BandAiGateway,
	headline,
	headlineLoading,
	projectTable,
	projectTableLoading,
} from "./view-table"

// `VercelPage`: the team overview, or the projects list.

type H = HtmlBuilder<Message>

const VERCEL_DESCRIPTION =
	"Requests, cache and builds across the team; functions, outbound calls and AI Gateway spend from Vercel's drains."

const VERCEL_ICON = (h: H) => icon(h, "VercelIcon", { size: 16, className: "text-foreground" })

/** Nothing in the window: either nothing is forwarded yet, or the drains have not delivered. */
const noDataYet = (h: H, status: VercelIntegrationStatus): Html => {
	const { title, description } = status.logsEnabled
		? {
				title: "Waiting for Vercel's first logs",
				description:
					"The logs drain delivers within a minute of a request reaching a forwarded project. This page updates on its own; a quiet project needs one request.",
			}
		: status.tracesEnabled
			? {
					title: "No deployment traces in this window",
					description:
						"Only traces are forwarded, so projects appear here once they send deployment traces. Turn logs on for the connection to count requests, cache hits and errors.",
				}
			: {
					title: "Nothing is forwarded",
					description: "Turn logs or traces on for the connection to fill this page.",
				}
	return integrationNotConnected(h, {
		icon: VERCEL_ICON(h),
		title,
		description,
		integration: "vercel",
		actionLabel: "Check the connection",
		actionVariant: "outline",
		docsPage: "vercel",
	})
}

/** A traces-only connection counts no requests: say why the request numbers read zero. */
const tracesOnlyNotice = (h: H): Html =>
	drainNotice(h, {
		lead: "Only traces are forwarded.",
		text: "Requests, cache hits and error logs come from the logs drain; latency and cold starts still show.",
		actionLabel: "Forward logs",
	})

const fillRequests = (rows: ReadonlyArray<VercelInfraRequestBucket>, window: TimeWindow | null) =>
	window === null ? rows : fillBuckets(rows, seriesInput(window), zeroRequestBucket)

export type ListFrame = Readonly<{
	status: VercelIntegrationStatus
	time: TimeSearch
	clock: Clock
}>

const projectNames = (status: VercelIntegrationStatus): ReadonlyMap<string, string> =>
	new Map(Arr.map(status.projects, (project) => [project.id, project.name] as const))

const bandAiGateway = (model: Model, status: VercelIntegrationStatus): BandAiGateway => {
	if (!status.aiGatewayEnabled) return "off"
	const ai = dataOf(model.aiGateway.data)
	if (ai !== null)
		return {
			summary: ai.summary,
			spark: Arr.map(fillAiSeries(ai.timeseries, model.window), (row) => row.costUsd),
		}
	return failureOf(model.aiGateway.data) === null ? null : "failed"
}

const aiGatewaySection = (h: H, model: Model, frame: ListFrame): Html =>
	readSection(h, {
		title: "AI Gateway spend",
		hint: "by calling project, most spend first",
		read: { data: model.aiGateway.data, onRetry: Message.ClickedRetryAiGateway() },
		off: frame.status.aiGatewayEnabled
			? null
			: {
					lead: "AI Gateway is off.",
					text: "Turn on the AI Gateway drain to see model spend per project, and spend made outside any project.",
				},
		failure: "Couldn't load AI Gateway usage",
		loading: () => skeletonRows(h, 3, () => [skeleton(h, "h-3 w-full")]),
		body: (data) =>
			data.summary.requests === 0
				? [dataTableEmpty(h, ["No AI Gateway requests in this window"])]
				: [aiGatewayProjectsTable(h, data.projects, projectNames(frame.status), frame.time)],
	})

const overviewBody = (h: H, model: Model, frame: ListFrame): ReadonlyArray<Html> => {
	const projectsFailure = failureOf(model.projects.data)
	const projects = dataOf(model.projects.data)
	if (projectsFailure !== null)
		return [
			errorState(h, {
				failure: projectsFailure,
				title: "Couldn't load Vercel projects",
				onRetry: Message.ClickedRetryProjects(),
			}),
		]
	if (projects === null) return [headlineLoading(h)]
	if (vercelProjectRows(frame.status.projects, projects).length === 0) return [noDataYet(h, frame.status)]
	const bucketsFailure = failureOf(model.buckets.data)
	const names = projectNames(frame.status)
	const nameOf = (projectId: string) => names.get(projectId) ?? projectId
	return [
		headline(h, {
			totals: vercelFleetTotals(projects),
			projectCount: projects.length,
			buckets: fillRequests(dataOf(model.buckets.data) ?? [], model.window),
			aiGateway: bandAiGateway(model, frame.status),
		}),
		...(bucketsFailure === null
			? []
			: [
					errorState(h, {
						failure: bucketsFailure,
						title: "Couldn't load the request series",
						onRetry: Message.ClickedRetryBuckets(),
						variant: "row",
					}),
				]),
		...(frame.status.logsEnabled ? [] : [tracesOnlyNotice(h)]),
		aiGatewaySection(h, model, frame),
		buildsSection(h, {
			read: { data: model.deployments.data, onRetry: Message.ClickedRetryDeployments() },
			clock: frame.clock,
			projectName: nameOf,
		}),
		speedInsightsSection(h, {
			read: { data: model.speedInsights.data, onRetry: Message.ClickedRetrySpeedInsights() },
			enabled: frame.status.speedInsightsEnabled,
		}),
		webAnalyticsSection(h, {
			read: { data: model.webAnalytics.data, onRetry: Message.ClickedRetryWebAnalytics() },
			enabled: frame.status.webAnalyticsEnabled,
			compact: true,
		}),
		auditLogSection(h, {
			read: { data: model.auditLog.data, onRetry: Message.ClickedRetryAuditLog() },
			enabled: frame.status.auditLogEnabled,
			clock: frame.clock,
			projectName: nameOf,
		}),
	]
}

const projectsBody = (h: H, model: Model, frame: ListFrame): ReadonlyArray<Html> => {
	const projectsFailure = failureOf(model.projects.data)
	const projects = dataOf(model.projects.data)
	if (projectsFailure !== null)
		return [
			errorState(h, {
				failure: projectsFailure,
				title: "Couldn't load Vercel projects",
				onRetry: Message.ClickedRetryProjects(),
			}),
		]
	if (projects === null) return [projectTableLoading(h)]
	const rows = vercelProjectRows(frame.status.projects, projects)
	if (rows.length === 0) return [noDataYet(h, frame.status)]
	const q = Str.toLowerCase(Str.trim(model.search.q ?? ""))
	const shown =
		q === ""
			? rows
			: Arr.filter(rows, (row) =>
					Str.includes(q)(Str.toLowerCase(`${row.name} ${row.framework ?? ""} ${row.projectId}`)),
				)
	return [
		...(frame.status.logsEnabled ? [] : [tracesOnlyNotice(h)]),
		searchToolbar(h, {
			id: "vercel-search",
			value: model.search.q ?? "",
			placeholder: "Search projects…",
			onInput: (value) => Message.ChangedSearch({ value }),
			onClear: Message.ClickedClearSearch(),
			trailing:
				shown.length === rows.length
					? countLabel(rows.length, rows.length, "project")
					: `${shown.length} of ${rows.length} projects`,
		}),
		shown.length === 0
			? filteredEmpty(h, {
					noun: "projects",
					description: "Clear the search to see them all.",
					onClear: Message.ClickedClearSearch(),
					clearLabel: "Clear search",
				})
			: projectTable(h, { rows: shown, sort: model.sort, time: frame.time, clock: frame.clock }),
	]
}

const viewTabs = (h: H, model: Model, status: VercelIntegrationStatus): Html => {
	const projects = dataOf(model.projects.data)
	const count = projects === null ? null : vercelProjectRows(status.projects, projects).length
	const time = pickTimeSearch(model.search)
	return viewTabStrip(
		h,
		"Vercel views",
		[
			{ id: "overview", title: "Overview", href: hrefOf(AppRoute.InfraVercel({ search: time })) },
			{
				id: "projects",
				title: count === null ? "Projects" : `Projects ${count}`,
				href: hrefOf(AppRoute.InfraVercel({ search: { ...time, view: "projects" } })),
			},
		],
		isProjectsView(model.search) ? "projects" : "overview",
	)
}

const header = (h: H, status: VercelIntegrationStatus | null): Html =>
	pageHero(h, {
		title: "Vercel",
		description: VERCEL_DESCRIPTION,
		trailing:
			status?.team === null || status === null ? undefined : heroChip(h, ["team ", status.team.name]),
	})

/** `VercelListPage`: header and view tabs, then the overview or the projects. */
export const listBody = (h: H, model: Model, frame: ListFrame): Html => {
	const projectsView = isProjectsView(model.search)
	const waiting = AsyncData.isRefreshing(model.projects.data)
	return h.div(
		[h.Class("space-y-6")],
		[
			header(h, frame.status),
			viewTabs(h, model, frame.status),
			h.div(
				[h.Class(cn("space-y-6", refreshingClass(waiting))), ...(waiting ? [h.AriaBusy(true)] : [])],
				projectsView ? projectsBody(h, model, frame) : overviewBody(h, model, frame),
			),
		],
	)
}

const notConnected = (h: H): Html =>
	integrationNotConnected(h, {
		icon: VERCEL_ICON(h),
		title: "Connect Vercel to see requests, builds and AI Gateway spend",
		description:
			"Paste a Vercel token and Maple adds drains to your team. Requests, cache hits, cold starts, builds and AI Gateway usage then show here, per project.",
		integration: "vercel",
		actionLabel: "Connect Vercel",
		docsPage: "vercel",
	})

const loading = (h: H): Html => h.div([h.Class("space-y-6")], [header(h, null), headlineLoading(h)])

const statusView = (h: H, model: Model, timeZone: string): Html => {
	const loaded = (status: VercelIntegrationStatus): Html =>
		status.connected
			? listBody(h, model, {
					status,
					time: pickTimeSearch(model.search),
					clock: { nowMs: model.nowMs, timeZone },
				})
			: h.div([h.Class("space-y-6")], [header(h, status), notConnected(h)])
	return AsyncData.match(model.status.data, {
		onIdle: () => loading(h),
		onLoading: () => loading(h),
		onFailure: (failure) =>
			h.div(
				[h.Class("space-y-6")],
				[
					header(h, null),
					errorState(h, {
						failure,
						title: "Couldn't load the Vercel connection",
						onRetry: Message.ClickedRetryStatus(),
					}),
				],
			),
		onStale: ({ data }) => loaded(data),
		onSuccess: loaded,
		onRefreshing: loaded,
	})
}

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) =>
	dashboardPage(
		h,
		{
			scrollClassName: "gap-6",
			actions: pageTime(h, {
				search: model.search,
				defaultPreset: DEFAULT_PRESET,
				window: model.window,
				picker: model.timePicker,
				toPickerMessage: (message) => Message.GotTimePickerMessage({ message }),
				onReset: Message.ClickedResetTimeRange(),
				onReload: Message.ClickedReload(),
				isReloading: model.isReloading,
			}),
		},
		[statusView(h, model, inputs.context.timeZone)],
	),
)
