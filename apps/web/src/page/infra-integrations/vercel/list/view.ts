import type {
	VercelAiGatewayResponse,
	VercelInfraRequestBucket,
	VercelIntegrationStatus,
} from "@maple/domain/http"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { cn } from "@maple/ui/lib/utils"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import {
	fillBuckets,
	vercelFleetTotals,
	vercelProjectRows,
	zeroRequestBucket,
} from "../../../../components/infra/vercel/list-model"
import * as BarChart from "../../../../charts/bar-chart"
import { ResolveThemeColors } from "../../../../charts/theme-colors"
import type { TimeWindow } from "../../../../data/time-range"
import { errorState } from "../../../../ui/error-state"
import { icon } from "../../../../ui/icon"
import { segmentedSelect } from "../../../../ui/segmented-select"
import type { PageViewInputs } from "../../../contract"
import { dashboardPage } from "../../../kit/dashboard-page"
import { filteredEmpty } from "../../../kit/signal-empty-state"
import { heroChip } from "../../../infra/kit/hero-chip"
import { countLabel, pageHero, searchToolbar } from "../../../infra/kit/page-parts"
import { pickTimeSearch, type TimeSearch } from "../../../infra/kit/view-tabs"
import { integrationLinkActions, integrationNotConnected } from "../../kit/empty-states"
import { pageTime } from "../../kit/page-time"
import { DEFAULT_PRESET, seriesInput } from "../data"
import {
	aiGatewayEmpty,
	aiGatewayLoading,
	aiGatewayPanel,
	barChartSlot,
	type BarChartSlot,
	type Clock,
	dataOf,
	failureOf,
	fillAiSeries,
} from "../view-parts"
import { Message, type Model } from "./model"
import {
	type BandAiGateway,
	fleetBand,
	fleetBandLoading,
	projectTable,
	projectTableLoading,
} from "./view-table"

// `VercelPage` and `VercelListPage`.

type H = HtmlBuilder<Message>

const VERCEL_DESCRIPTION =
	"Requests, cache and errors from Vercel's log drain; latency and AI Gateway usage from its trace drain."

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

/** A traces-only connection counts no requests: say why the request columns read zero. */
const tracesOnlyNotice = (h: H): Html =>
	h.div(
		[
			h.Class(
				"flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/30 px-4 py-2.5",
			),
		],
		[
			h.p(
				[h.Class("text-xs text-muted-foreground")],
				[
					h.span([h.Class("font-medium text-foreground")], ["Only traces are forwarded. "]),
					"Requests, cache hits and error logs come from the logs drain; latency still shows.",
				],
			),
			integrationLinkActions(h, {
				integration: "vercel",
				actionLabel: "Forward logs",
				actionVariant: "outline",
			}),
		],
	)

const fillRequests = (rows: ReadonlyArray<VercelInfraRequestBucket>, window: TimeWindow | null) =>
	window === null ? rows : fillBuckets(rows, seriesInput(window), zeroRequestBucket)

export type ListFrame = Readonly<{
	status: VercelIntegrationStatus
	time: TimeSearch
	clock: Clock
	bar: BarChartSlot
}>

const projectsBody = (h: H, model: Model, frame: ListFrame): ReadonlyArray<Html> => {
	const projectsFailure = failureOf(model.projects.data)
	const projects = dataOf(model.projects.data)
	if (projectsFailure !== null)
		return [
			errorState(h, {
				failure: projectsFailure,
				title: "Failed to load Vercel projects",
				onRetry: Message.ClickedRetryProjects(),
			}),
		]
	if (projects === null) return [fleetBandLoading(h), projectTableLoading(h)]
	const rows = vercelProjectRows(frame.status.projects, projects)
	if (rows.length === 0) return [noDataYet(h, frame.status)]
	const bucketsFailure = failureOf(model.buckets.data)
	const buckets = fillRequests(dataOf(model.buckets.data) ?? [], model.window)
	const ai = dataOf(model.aiGateway.data)
	const aiGateway: BandAiGateway =
		ai === null
			? failureOf(model.aiGateway.data) === null
				? null
				: "failed"
			: {
					summary: ai.summary,
					spark: fillAiSeries(ai.timeseries, model.window).map((row) => row.costUsd),
				}
	const q = (model.search.q ?? "").trim().toLowerCase()
	const shown =
		q === ""
			? rows
			: rows.filter((row) =>
					`${row.name} ${row.framework ?? ""} ${row.projectId}`.toLowerCase().includes(q),
				)
	return [
		fleetBand(h, {
			totals: vercelFleetTotals(projects),
			projectCount: projects.length,
			buckets,
			aiGateway,
		}),
		...(bucketsFailure === null
			? []
			: [
					errorState(h, {
						failure: bucketsFailure,
						title: "Failed to load the request series",
						onRetry: Message.ClickedRetryBuckets(),
						variant: "row",
					}),
				]),
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

const aiGatewayBody = (h: H, model: Model, frame: ListFrame): ReadonlyArray<Html> => {
	const data: VercelAiGatewayResponse | null = dataOf(model.aiGateway.data)
	const failure = failureOf(model.aiGateway.data)
	if (failure !== null)
		return [
			errorState(h, {
				failure,
				title: "Failed to load AI Gateway usage",
				onRetry: Message.ClickedRetryAiGateway(),
			}),
		]
	if (data === null) return [aiGatewayLoading(h)]
	if (data.summary.requests === 0) return [aiGatewayEmpty(h)]
	return [
		aiGatewayPanel(h, {
			data,
			timeseries: fillAiSeries(data.timeseries, model.window),
			projectNames: new Map(frame.status.projects.map((project) => [project.id, project.name])),
			time: frame.time,
			bar: frame.bar,
		}),
	]
}

const header = (h: H, model: Model, status: VercelIntegrationStatus | null): Html => {
	const projects = dataOf(model.projects.data)
	const count =
		status === null || projects === null ? null : vercelProjectRows(status.projects, projects).length
	return pageHero(h, {
		title: "Vercel",
		description: VERCEL_DESCRIPTION,
		trailing:
			status?.team === null || status === null ? undefined : heroChip(h, ["team ", status.team.name]),
		actions:
			status === null || !status.connected
				? undefined
				: [
						segmentedSelect(h, {
							size: "xs",
							ariaLabel: "Vercel view",
							options: [
								{
									value: "projects" as const,
									label: count === null ? "Projects" : `Projects ${count}`,
								},
								{ value: "aiGateway" as const, label: "AI Gateway" },
							],
							value: model.search.view ?? "projects",
							onChange: (view) => Message.ClickedView({ view }),
						}),
					],
	})
}

/** `VercelListPage`: header with the view pivot, then the projects or AI Gateway usage. */
export const listBody = (h: H, model: Model, frame: ListFrame): Html => {
	const view = model.search.view ?? "projects"
	const waiting =
		view === "projects"
			? AsyncData.isRefreshing(model.projects.data)
			: AsyncData.isRefreshing(model.aiGateway.data)
	return h.div(
		[h.Class("space-y-6")],
		[
			header(h, model, frame.status),
			h.div(
				[h.Class(cn("space-y-4", refreshingClass(waiting))), ...(waiting ? [h.AriaBusy(true)] : [])],
				view === "projects" ? projectsBody(h, model, frame) : aiGatewayBody(h, model, frame),
			),
		],
	)
}

const notConnected = (h: H): Html =>
	integrationNotConnected(h, {
		icon: VERCEL_ICON(h),
		title: "Connect Vercel to see requests, cache and AI Gateway spend",
		description:
			"Paste a Vercel token and Maple adds log and trace drains to your team. Requests, cache hits, errors and AI Gateway usage then show here, per project.",
		integration: "vercel",
		actionLabel: "Connect Vercel",
		docsPage: "vercel",
	})

const loading = (h: H, model: Model): Html =>
	h.div([h.Class("space-y-6")], [header(h, model, null), fleetBandLoading(h)])

const statusView = (h: H, model: Model, timeZone: string): Html => {
	const loaded = (status: VercelIntegrationStatus): Html =>
		status.connected
			? listBody(h, model, {
					status,
					time: pickTimeSearch(model.search),
					clock: { nowMs: model.nowMs, timeZone },
					bar: barChartSlot(
						h,
						model,
						(chartId, message) => Message.GotChartMessage({ chartId, message }),
						timeZone,
					),
				})
			: h.div([h.Class("space-y-6")], [header(h, model, status), notConnected(h)])
	return AsyncData.match(model.status.data, {
		onIdle: () => loading(h, model),
		onLoading: () => loading(h, model),
		onFailure: (failure) =>
			h.div(
				[h.Class("space-y-6")],
				[
					header(h, model, null),
					errorState(h, {
						failure,
						title: "Failed to load the Vercel connection",
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
	h.div(
		[h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: BarChart.BAR_CHART_TOKENS }))],
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
				},
				[statusView(h, model, inputs.context.timeZone)],
			),
		],
	),
)
