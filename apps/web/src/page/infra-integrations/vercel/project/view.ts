import type { VercelDeploymentSummary, VercelProjectStatus } from "@maple/domain/http"
import { formatCost } from "@maple/agent-sessions"
import { errorRateLevel } from "@maple/ui/lib/error-rate"
import { EMPTY_VALUE, formatNumber, formatPercent } from "@maple/ui/lib/format"
import { Array as Arr, Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as BarChart from "@maple/views/charts/bar-chart"
import { INFRA_CHART_TOKENS } from "@maple/views/charts/infra-metric-series"
import { ResolveThemeColors } from "@maple/views/charts/theme-colors"
import { linkButton } from "@maple/views/ui/button"
import { errorState } from "@maple/views/ui/error-state"
import { icon } from "@maple/views/ui/icon"
import { hstack } from "@maple/views/ui/stack"
import { statusDot } from "@maple/views/ui/status-dot"
import { textLink } from "@maple/views/ui/text-link"
import { typography } from "@maple/views/ui/typography"
import { deployLabel } from "../../../../components/infra/vercel/deploy-signals"
import {
	fillBuckets,
	vercelProjectRow,
	vercelProjectTracesWhere,
	type VercelProjectRow,
	zeroRequestBucket,
} from "../../../../components/infra/vercel/list-model"
import { projectDeploySignals } from "../../../../components/infra/vercel/project-signals"
import { AppRoute, hrefOf } from "../../../../route"
import type { VercelProjectTab } from "../../../../route/search"
import type { PageViewInputs } from "../../../contract"
import { dashboardPage } from "../../../kit/dashboard-page"
import { relativeTime } from "../../../kit/relative-time"
import { statRail, statRailItem, statRailLoading } from "../../../kit/stat-rail"
import { linkTabStrip } from "../../../kit/underline-tabs"
import { heroChip } from "../../../infra/kit/hero-chip"
import { pageHero } from "../../../infra/kit/page-parts"
import { pickTimeSearch, type TimeSearch } from "../../../infra/kit/view-tabs"
import { pageTime } from "../../kit/page-time"
import { DEFAULT_PRESET, seriesInput } from "../data"
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
import { tabOf } from "./update"
import { projectRail } from "./view-rail"
import {
	breakdownPanel,
	errorLogsHref,
	regressionCallout,
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
	// The latency read waits for the status; without the trace drain there is none to wait for.
	const latency = status !== null && !status.tracesEnabled ? null : dataOf(model.latency.data)
	const hasLatency = status === null || status.tracesEnabled
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
	return detail === null ? [] : [topErrors(h, detail.errors, clock, errorLogsHref(model.projectId, time))]
}

const functionsStats = (h: H, row: VercelProjectRow | null): Html =>
	row === null
		? statRailLoading(h, 2, 2)
		: statRail(h, { columns: 2 }, [
				statRailItem(h, { eyebrow: "Invocations", value: formatNumber(row.invocations) }),
				statRailItem(h, {
					eyebrow: "Cold starts",
					value:
						row.coldStartPercent === null
							? EMPTY_VALUE
							: formatPercent(row.coldStartPercent / 100),
					tone: errorRateLevel(row.coldStartPercent === null ? 0 : row.coldStartPercent / 100),
					subline: "of invocations started a new instance",
				}),
			])

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
				...(tracesEnabled ? [functionsStats(h, projectRowOf(model))] : []),
				functionsSection(h, {
					read: { data: model.functions.data, onRetry: Message.ClickedRetryFunctions() },
					tracesEnabled,
				}),
				dependenciesSection(h, {
					read: { data: model.dependencies.data, onRetry: Message.ClickedRetryDependencies() },
					tracesEnabled,
					serviceMapHref: serviceMapHref(model, time),
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
				}),
				webAnalyticsSection(h, {
					read: { data: model.webAnalytics.data, onRetry: Message.ClickedRetryWebAnalytics() },
					enabled: status?.webAnalyticsEnabled ?? true,
					compact: false,
				}),
			]
		case "aiGateway":
			return [aiGatewaySection(h, model, time, clock.timeZone, status?.aiGatewayEnabled ?? true)]
	}
}

/** `VercelProjectPage`'s main column below the top bar: the header, the tabs, then the active tab. */
export const projectPage = (h: H, model: Model, timeZone: string): ReadonlyArray<Html> => {
	const time = pickTimeSearch(model.search)
	const clock = { nowMs: model.nowMs, timeZone }
	return [header(h, model, time, clock), tabStrip(h, model, time), ...tabBody(h, model, time, clock)]
}

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const timeZone = inputs.context.timeZone
	return h.div(
		[h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: THEME_TOKENS }))],
		[
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
					rightPanel: projectRail(
						h,
						model,
						{ nowMs: model.nowMs, timeZone },
						serviceMapHref(model, pickTimeSearch(model.search)),
					),
				},
				projectPage(h, model, timeZone),
			),
		],
	)
})
