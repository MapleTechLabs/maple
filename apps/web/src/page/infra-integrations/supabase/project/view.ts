import { Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { BAR_CHART_TOKENS } from "../../../../charts/bar-chart"
import { INFRA_CHART_TOKENS } from "../../../../charts/infra-metric-series"
import { ResolveThemeColors } from "../../../../charts/theme-colors"
import { linkButton } from "../../../../ui/button"
import { errorState } from "../../../../ui/error-state"
import { icon } from "../../../../ui/icon"
import type { PageViewInputs } from "../../../contract"
import { dashboardPage } from "../../../kit/dashboard-page"
import { relativeTime } from "../../../kit/relative-time"
import { skeleton } from "../../../../ui/skeleton"
import { pageHero } from "../../../infra/kit/page-parts"
import { integrationNotConnected } from "../../kit/empty-states"
import { pageTime } from "../../kit/page-time"
import { type SparkWindow } from "../../kit/window-sparkline"
import { toEpochMs } from "@maple/ui/lib/time-format"
import { healthPill, projectHealth } from "../health"
import { supabaseDashboardHref, supabaseLogsHref } from "../links"
import type { SupabaseProjectRow, SupabaseStatus } from "../model"
import { type HealthStrip, healthStrip } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { DEFAULT_PRESET, timeseriesInput } from "./update"
import { attentionPanel } from "./view-attention"
import { callersPanel } from "./view-callers"
import { issuesPanel } from "./view-issues"
import { postgresRow } from "./view-postgres"
import { HEALTH_STRIP_GRID, healthStripView } from "./view-strip"
import { trafficPanel } from "./view-traffic"

// `/infra/supabase/$projectRef`: the project's Overview.

type H = HtmlBuilder<Message>
type DiscoveredProject = SupabaseStatus["projects"][number]

const THEME_TOKENS = [...INFRA_CHART_TOKENS, ...BAR_CHART_TOKENS]

/** The project as discovery lists it, once the status loaded. */
const discoveredOf = (model: Model): DiscoveredProject | null =>
	Option.getOrNull(
		Option.flatMap(AsyncData.getData(model.status.data), (status) =>
			Option.fromNullishOr(status.projects.find((project) => project.ref === model.projectRef)),
		),
	)

/** The project's summary row in the fleet read, once loaded. */
const summaryOf = (model: Model): SupabaseProjectRow | null =>
	Option.getOrNull(
		Option.flatMap(AsyncData.getData(model.projects.data), (rows) =>
			Option.fromNullishOr(rows.find((row) => row.projectRef === model.projectRef)),
		),
	)

export const titleOf = (model: Model): string => discoveredOf(model)?.name || model.projectRef

/** The sparklines' x axis: the page's window, at the timeseries' bucket width. */
const sparkWindowOf = (model: Model): SparkWindow | null =>
	model.window === null
		? null
		: {
				startMs: toEpochMs(model.window.startTime),
				endMs: toEpochMs(model.window.endTime),
				bucketMs: timeseriesInput(model, model.window).bucketSeconds * 1000,
			}

const EMPTY_WINDOW: SparkWindow = { startMs: 0, endMs: 0, bucketMs: 0 }

/** The timeseries' strip figures, once it loaded with at least one bucket. */
const stripOf = (model: Model): HealthStrip | null =>
	Option.getOrNull(Option.flatMapNullishOr(AsyncData.getData(model.timeseries.data), healthStrip))

const stripLoading = (h: H): Html =>
	h.div(
		[h.Class(HEALTH_STRIP_GRID), h.AriaBusy(true)],
		Array.from({ length: 6 }, () => skeleton(h, "h-[118px] rounded-md")),
	)

const stripView = (h: H, model: Model, timeZone: string): Html => {
	const failed = (failure: Parameters<typeof errorState>[1]["failure"]) =>
		errorState(h, {
			failure,
			title: "Failed to load project metrics",
			onRetry: Message.ClickedRetry({ section: "timeseries" }),
		})
	const strip = (rows: ReadonlyArray<unknown>) => {
		const figures = stripOf(model)
		return figures === null || rows.length === 0
			? noMetrics(h, discoveredOf(model))
			: healthStripView(h, figures, sparkWindowOf(model) ?? EMPTY_WINDOW, timeZone)
	}
	return AsyncData.match(model.timeseries.data, {
		onIdle: () => stripLoading(h),
		onLoading: () => stripLoading(h),
		onFailure: failed,
		onStale: ({ error, data }) => (data.length === 0 ? failed(error) : strip(data)),
		onSuccess: strip,
		onRefreshing: strip,
	})
}

/** Nothing scraped in the window: says why, and where the switch is. */
const noMetrics = (h: H, project: DiscoveredProject | null): Html =>
	integrationNotConnected(h, {
		icon: icon(h, "SupabaseIcon", { size: 16 }),
		title: "No metrics for this project in this time range",
		description:
			project !== null && !project.metricsEnabled
				? "Metrics collection is off for this project. Turn on Metrics to start scraping it."
				: "Maple scrapes every minute once Metrics is on. Try a wider time range, or check the connection.",
		integration: "supabase",
		actionLabel: "Manage projects",
		actionVariant: "outline",
	})

/** The logs page filtered to this project's polled logs, over the same time range. */
export const projectLogsHref = (model: Model): string => supabaseLogsHref(model.search, model.projectRef)

/** "eu-west-1 · Scraped 23s ago": the region and the latest sample. */
const heroMeta = (
	h: H,
	project: DiscoveredProject | null,
	summary: SupabaseProjectRow | null,
	clock: Readonly<{ nowMs: number; timeZone: string }>,
): ReadonlyArray<Html | string> => {
	const parts: ReadonlyArray<Html | string> = [
		...(project === null || project.region === "" ? [] : [project.region]),
		...(summary === null || summary.lastSeen === ""
			? []
			: [relativeTime(h, { value: summary.lastSeen, ...clock, prefix: "Scraped", tooltip: "title" })]),
	]
	return parts.length === 0
		? []
		: [
				h.p(
					[h.Class("font-mono text-xs text-muted-foreground")],
					parts.flatMap((part, index) => (index === 0 ? [part] : [" · ", part])),
				),
			]
}

const heroActions = (h: H, model: Model, project: DiscoveredProject | null): ReadonlyArray<Html> => [
	...(project?.logsEnabled === true
		? [linkButton(h, { size: "sm", variant: "outline", href: projectLogsHref(model) }, ["View logs"])]
		: []),
	linkButton(
		h,
		{
			size: "sm",
			variant: "outline",
			href: supabaseDashboardHref(model.projectRef),
			attributes: [h.Target("_blank"), h.Rel("noopener noreferrer")],
		},
		["Open in Supabase", icon(h, "ExternalLinkIcon", { size: 12 })],
	),
]

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const timeZone = inputs.context.timeZone
	const clock = { nowMs: model.nowMs, timeZone }
	const project = discoveredOf(model)
	const summary = summaryOf(model)
	const strip = stripOf(model)
	const theme = model.themeColors
	const isLogsEnabled = project?.logsEnabled === true
	const isStatusLoaded = AsyncData.isSuccess(model.status.data) || AsyncData.isRefreshing(model.status.data)
	return h.div(
		[h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: THEME_TOKENS }))],
		[
			dashboardPage(
				h,
				{
					scrollClassName: "gap-4",
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
				[
					pageHero(h, {
						title: titleOf(model),
						trailing: isStatusLoaded
							? healthPill(h, projectHealth(project?.status ?? null, summary))
							: undefined,
						meta: heroMeta(h, project, summary, clock),
						actions: heroActions(h, model, project),
						className: "mb-2",
					}),
					stripView(h, model, timeZone),
					h.div(
						[h.Class("grid grid-cols-1 gap-4 lg:grid-cols-3")],
						[
							trafficPanel(h, model, theme, timeZone, isLogsEnabled),
							attentionPanel(h, model, strip, timeZone),
						],
					),
					callersPanel(h, model, sparkWindowOf(model)),
					postgresRow(h, model, { theme, limit: strip?.connections.limit ?? null, clock }),
					issuesPanel(h, model, { timeZone, isLogsEnabled, logsHref: projectLogsHref(model) }),
				],
			),
		],
	)
})
