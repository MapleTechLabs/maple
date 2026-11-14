import type { VercelDeploymentSummary, VercelProjectStatus } from "@maple/domain/http"
import { formatCost } from "@maple/agent-sessions"
import { Array as Arr, Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as BarChart from "@maple/views/charts/bar-chart"
import { INFRA_CHART_TOKENS } from "@maple/views/charts/infra-metric-series"
import { ResolveThemeColors } from "@maple/views/charts/theme-colors"
import { linkButton } from "@maple/views/ui/button"
import { errorState } from "@maple/views/ui/error-state"
import { icon } from "@maple/views/ui/icon"
import { hstack, vstack } from "@maple/views/ui/stack"
import { statusDot } from "@maple/views/ui/status-dot"
import { textLink } from "@maple/views/ui/text-link"
import { typography } from "@maple/views/ui/typography"
import { deployLabel } from "../deploy-signals"
import {
	fillBuckets,
	vercelProjectRow,
	vercelProjectTracesWhere,
	type VercelProjectRow,
	zeroRequestBucket,
} from "../list-model"
import { projectDeploySignals } from "../project-signals"
import { AppRoute, hrefOf } from "../../../../route"
import type { VercelProjectTab } from "../../../../route/search"
import type { PageViewInputs } from "../../../contract"
import { dashboardPage } from "../../../kit/dashboard-page"
import { relativeTime } from "../../../kit/relative-time"
import { linkTabStrip } from "../../../kit/underline-tabs"
import { heroChip } from "../../../infra/kit/hero-chip"
import { pageHero } from "../../../infra/kit/page-parts"
import { pickTimeSearch, type TimeSearch } from "../../../kit/view-tabs"
import { pageTime } from "../../../kit/page-time"
import { DEFAULT_PRESET, linkTime, seriesInput } from "../data"
import {
	aiGatewayEmpty,
	aiGatewayLoading,
	aiGatewayPanel,
	barChartSlot,
	type Clock,
	dataOf,
	failureOf,
	fillAiSeries,
} from "../view-parts"
import {
	buildsSection,
	dependenciesSection,
	drainNotice,
	functionsSection,
	readSection,
	speedInsightsSection,
	webAnalyticsSection,
} from "../sections"
import { Message, type Model } from "./model"
import { requestFilterOf, tabOf } from "./update"
import { projectRail } from "./view-rail"
import { functionSignals } from "./view-functions"
import {
	breakdownPanel,
	errorLogsHref,
	regressionCallout,
	requestScope,
	signals,
	signalsLoading,
	topErrors,
} from "./view-traffic"

// `VercelProjectPage`.

type H = HtmlBuilder<Message>

/** The strips name the status-class, severity and marker colours too. */
const THEME_TOKENS = [
	...INFRA_CHART_TOKENS,
	"--chart-2",
	"--severity-warn",
	"--severity-error",
	"--muted-foreground",
	...BarChart.BAR_CHART_TOKENS,
]

/** The inventory's view of the project; null while loading, failed, or when it is not listed. */
export const projectStatusOf = (model: Model): VercelProjectStatus | null =>
	Option.getOrNull(
		Arr.findFirst(dataOf(model.status.data)?.projects ?? [], (project) => project.id === model.projectId),
	)

/** The project's row: zeros when nothing arrived; a failed status read still shows it, under its id. */
export const projectRowOf = (model: Model): VercelProjectRow | null => {
	const projects = dataOf(model.projects.data)
	return projects === null
		? null
		: vercelProjectRow(model.projectId, dataOf(model.status.data)?.projects ?? [], projects)
}

export const titleOf = (model: Model): string =>
	projectStatusOf(model)?.name ?? projectRowOf(model)?.name ?? model.projectId

/** The service ingest names the project's runtime spans after; null until its row arrives. */
const serviceNameOf = (model: Model): string | null =>
	Option.getOrNull(
		Option.map(
			Arr.findFirst(dataOf(model.projects.data) ?? [], (row) => row.projectId === model.projectId),
			(row) => row.serviceName,
		),
	) || null

/** `production · main · 71bd04f "message" · deployed 1h ago by maya`. */
const productionLine = (h: H, production: VercelDeploymentSummary, clock: Clock): Html =>
	typography(h, { size: "2xs", tone: "muted", mono: true, truncate: true, className: "min-w-0" }, [
		Arr.join(
			[
				"production",
				...(production.branch === null || production.branch === "" ? [] : [production.branch]),
				production.commitMessage === null
					? deployLabel(production)
					: `${deployLabel(production)} "${production.commitMessage}"`,
				"deployed ",
			],
			" · ",
		),
		relativeTime(h, { value: production.createdAt, ...clock, mono: true }),
		production.creator === null ? "" : ` by ${production.creator}`,
	])

const header = (h: H, model: Model, time: TimeSearch, clock: Clock): Html => {
	const project = projectStatusOf(model)
	const production = project?.productionDeployment ?? null
	const row = projectRowOf(model)
	const serviceName = serviceNameOf(model)
	return pageHero(h, {
		title: hstack(h, { gap: "3", as: "span" }, [
			...(row === null
				? []
				: [
						statusDot(h, {
							tone: row.errorPercent !== null && row.errorPercent >= 1 ? "crit" : "ok",
							size: "lg",
						}),
					]),
			titleOf(model),
		]),
		trailing: [
			...(project?.framework === null || project === null ? [] : [heroChip(h, project.framework)]),
			...(production === null
				? []
				: [
						typography(h, { size: "2xs" }, [
							textLink(
								h,
								{
									href: `https://${production.url}`,
									tone: "muted",
									isMono: true,
									attributes: [h.Target("_blank"), h.Rel("noopener noreferrer")],
								},
								[production.url, icon(h, "ExternalLinkIcon", { size: 10 })],
							),
						]),
					]),
			...(serviceName === null
				? []
				: [
						h.a(
							[h.Href(hrefOf(AppRoute.Service({ serviceName, search: time })))],
							[heroChip(h, ["service ", serviceName])],
						),
					]),
		],
		meta: [
			production === null
				? typography(h, { size: "2xs", tone: "muted" }, ["No production deployment recorded"])
				: productionLine(h, production, clock),
		],
		actions: [
			linkButton(h, { size: "sm", variant: "outline", href: errorLogsHref(model.projectId, time) }, [
				icon(h, "FileIcon"),
				"Logs",
			]),
			linkButton(
				h,
				{
					size: "sm",
					variant: "outline",
					href: hrefOf(
						AppRoute.Traces({
							search: { ...time, whereClause: vercelProjectTracesWhere(model.projectId) },
						}),
					),
				},
				[icon(h, "PulseIcon"), "Traces"],
			),
		],
	})
}

const TABS: ReadonlyArray<Readonly<{ id: VercelProjectTab; title: string }>> = [
	{ id: "traffic", title: "Traffic" },
	{ id: "functions", title: "Functions" },
	{ id: "builds", title: "Builds" },
	{ id: "users", title: "Real users" },
	{ id: "aiGateway", title: "AI Gateway" },
]

/** The tally beside a tab, from a read the page already holds. */
const tabCount = (model: Model, tab: VercelProjectTab): number | string | undefined => {
	switch (tab) {
		case "functions":
			return dataOf(model.functions.data)?.length
		case "builds":
			return dataOf(model.deployments.data)?.length
		case "aiGateway": {
			const usage = dataOf(model.aiGateway.data)
			return usage === null ? undefined : formatCost(usage.summary.costUsd)
		}
		default:
			return undefined
	}
}

const tabStrip = (h: H, model: Model, time: TimeSearch): Html =>
	linkTabStrip(
		h,
		"Project views",
		Arr.map(TABS, (tab) => ({
			key: tab.id,
			label: tab.title,
			count: tabCount(model, tab.id),
			href: hrefOf(
				AppRoute.InfraVercelProject({
					projectId: model.projectId,
					search: tab.id === "traffic" ? time : { ...time, tab: tab.id },
				}),
			),
			isCurrent: tab.id === tabOf(model),
			isRouteActive: tab.id === tabOf(model),
		})),
	)

/** The project's own service on the service map: ingest names Vercel's runtime spans after the project. */
const serviceMapHref = (model: Model, time: TimeSearch): string =>
	hrefOf(AppRoute.ServiceMap({ search: { ...time, focusService: serviceNameOf(model) ?? titleOf(model) } }))

/** The regression callout over the linked strips; a skeleton until the series and the theme are in. */
const trafficSignals = (h: H, model: Model, clock: Clock): ReadonlyArray<Html> => {
	const failure = failureOf(model.buckets.data) ?? failureOf(model.latency.data)
	if (failure !== null)
		return [
			errorState(h, {
				failure,
				title: "Couldn't load this project's requests",
				onRetry: Message.ClickedRetryRequests(),
			}),
		]
	const status = dataOf(model.status.data)
	const raw = dataOf(model.buckets.data)
	// The latency read waits for the status; without the trace drain there is none to wait for, and
	// none is read while a breakdown filter narrows the requests (traces carry no log attributes).
	const hasLatency = (status === null || status.tracesEnabled) && requestFilterOf(model) === null
	const latency = hasLatency ? dataOf(model.latency.data) : null
	const theme = model.themeColors
	if (
		raw === null ||
		model.window === null ||
		(hasLatency && latency === null) ||
		theme === null ||
		model.chartRuntime._tag === "Loading"
	)
		return [signalsLoading(h)]
	const series = seriesInput(model.window)
	const buckets = fillBuckets(raw, series, zeroRequestBucket)
	const deploys = projectDeploySignals(buckets, dataOf(model.deployments.data) ?? [], series)
	const regression = deploys.regressions[deploys.regressions.length - 1]
	return [
		...(regression === undefined ? [] : [regressionCallout(h, regression, model.projectId)]),
		requestScope(h, model),
		signals(h, model, {
			buckets,
			latency,
			deploys,
			edgeP95Ms: projectRowOf(model)?.p95DurationMs ?? null,
			isWaiting: AsyncData.isRefreshing(model.buckets.data),
			theme,
			timeZone: clock.timeZone,
		}),
	]
}

const errorLogs = (h: H, model: Model, time: TimeSearch, clock: Clock): ReadonlyArray<Html> => {
	const failure = failureOf(model.detail.data)
	if (failure !== null)
		return [
			errorState(h, {
				failure,
				title: "Couldn't load error logs",
				onRetry: Message.ClickedRetryDetail(),
			}),
		]
	const detail = dataOf(model.detail.data)
	return detail === null
		? []
		: [
				topErrors(h, {
					errors: detail.errors,
					capped: detail.errorLogsCapped,
					sampled: detail.errorLogsSampled,
					projectId: model.projectId,
					time,
					clock,
				}),
			]
}

const aiGatewaySection = (h: H, model: Model, time: TimeSearch, timeZone: string, enabled: boolean): Html =>
	readSection(h, {
		title: "AI Gateway",
		hint: "requests this project made through Vercel AI Gateway",
		read: { data: model.aiGateway.data, onRetry: Message.ClickedRetryAiGateway() },
		off: enabled
			? null
			: {
					lead: "AI Gateway is off.",
					text: "Turn on the AI Gateway drain to see this project's model spend, tokens and errors.",
				},
		failure: "Couldn't load AI Gateway usage",
		loading: () => [aiGatewayLoading(h)],
		body: (data) =>
			data.summary.requests === 0
				? [aiGatewayEmpty(h, true)]
				: [
						aiGatewayPanel(h, {
							data,
							timeseries: fillAiSeries(data.timeseries, model.window),
							projectNames: new Map(),
							time,
							bar: barChartSlot(
								h,
								model,
								(chartId, message) => Message.GotChartMessage({ chartId, message }),
								timeZone,
							),
						}),
					],
	})

const tabBody = (h: H, model: Model, time: TimeSearch, clock: Clock): ReadonlyArray<Html> => {
	const status = dataOf(model.status.data)
	const tracesEnabled = status?.tracesEnabled ?? true
	switch (tabOf(model)) {
		case "traffic":
			return [
				...(status === null || status.logsEnabled
					? []
					: [
							drainNotice(h, {
								lead: "Logs are off.",
								text: "Requests, status codes, cache hits and error logs come from the logs drain.",
								actionLabel: "Forward logs",
							}),
						]),
				...trafficSignals(h, model, clock),
				breakdownPanel(h, model),
				...errorLogs(h, model, time, clock),
			]
		case "functions":
			return [
				...(tracesEnabled ? functionSignals(h, model, clock.timeZone) : []),
				functionsSection(h, {
					read: { data: model.functions.data, onRetry: Message.ClickedRetryFunctions() },
					tracesEnabled,
					select: {
						route: model.search.route,
						onSelect: (route) => Message.ClickedFunctionRoute({ route }),
					},
				}),
				dependenciesSection(h, {
					read: { data: model.dependencies.data, onRetry: Message.ClickedRetryDependencies() },
					tracesEnabled,
					serviceMapHref: serviceMapHref(model, time),
					select: {
						host: model.search.host,
						onSelect: (host) => Message.ClickedDependencyHost({ host }),
					},
				}),
			]
		case "builds":
			return [
				buildsSection(h, {
					read: { data: model.deployments.data, onRetry: Message.ClickedRetryDeployments() },
					clock,
					projectName: null,
				}),
			]
		case "users":
			return [
				speedInsightsSection(h, {
					read: { data: model.speedInsights.data, onRetry: Message.ClickedRetrySpeedInsights() },
					enabled: status?.speedInsightsEnabled ?? true,
					pick: {
						picked:
							model.search.vitalsBy === undefined || model.search.vitalsValue === undefined
								? null
								: { by: model.search.vitalsBy, value: model.search.vitalsValue },
						onPick: (by, value) => Message.ClickedVitalsRow({ by, value }),
					},
				}),
				webAnalyticsSection(h, {
					read: { data: model.webAnalytics.data, onRetry: Message.ClickedRetryWebAnalytics() },
					enabled: status?.webAnalyticsEnabled ?? true,
					compact: false,
					pick: {
						picked:
							model.search.visitsBy === undefined || model.search.visitsValue === undefined
								? null
								: { by: model.search.visitsBy, value: model.search.visitsValue },
						onPick: (by, value) => Message.ClickedVisitsRow({ by, value }),
					},
				}),
			]
		case "aiGateway":
			return [aiGatewaySection(h, model, time, clock.timeZone, status?.aiGatewayEnabled ?? true)]
	}
}

/**
 * `VercelProjectPage`'s main column below the top bar: the header, the tabs, then the active tab.
 * One column on purpose: the page's scroll area is a flex column, and its direct children that clip
 * (the tab strip, the chart panels) would shrink to nothing once the page is taller than the view.
 */
export const projectPage = (h: H, model: Model, timeZone: string): Html => {
	const time = linkTime(pickTimeSearch(model.search))
	const clock = { nowMs: model.nowMs, timeZone }
	return vstack(h, { gap: "6", className: "min-w-0" }, [
		header(h, model, time, clock),
		tabStrip(h, model, time),
		...tabBody(h, model, time, clock),
	])
}

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const timeZone = inputs.context.timeZone
	return h.div(
		[h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: THEME_TOKENS }))],
		[
			dashboardPage(
				h,
				{
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
					rightPanel: projectRail(
						h,
						model,
						{ nowMs: model.nowMs, timeZone },
						serviceMapHref(model, linkTime(pickTimeSearch(model.search))),
					),
				},
				[projectPage(h, model, timeZone)],
			),
		],
	)
})
