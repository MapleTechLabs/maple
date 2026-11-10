import type { VercelIntegrationStatus } from "@maple/domain/http"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { TONE_FILL } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { Array as Arr, String as Str } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import {
	inScope,
	type ProjectHealth,
	problemsFirst,
	projectHealth,
} from "../../../../components/infra/vercel/overview-model"
import { drainState, VERCEL_DRAINS } from "../../../../components/integrations/vercel-model"
import type { VercelProjectScope } from "../../../../route/search"
import { INFRA_CHART_TOKENS } from "@maple/views/charts/infra-metric-series"
import { ResolveThemeColors } from "@maple/views/charts/theme-colors"
import { errorState } from "@maple/views/ui/error-state"
import { grid } from "@maple/views/ui/grid"
import { icon } from "@maple/views/ui/icon"
import { hstack } from "@maple/views/ui/stack"
import { statusDot } from "@maple/views/ui/status-dot"
import type { PageViewInputs } from "../../../contract"
import { dashboardPage } from "../../../kit/dashboard-page"
import { FLEET_BAND_BOXED, fleetBand, fleetBandLoading } from "../../../infra/kit/fleet-band"
import { heroChip } from "../../../infra/kit/hero-chip"
import { pageHeroParts } from "../../../infra/kit/page-parts"
import { pickTimeSearch, type TimeSearch } from "../../../infra/kit/view-tabs"
import { integrationNotConnected } from "../../kit/empty-states"
import { pageTime } from "../../kit/page-time"
import { DEFAULT_PRESET } from "../data"
import { drainNotice } from "../sections"
import { type Clock, dataOf, failureOf } from "../view-parts"
import { type Overview, overviewOf } from "./derive"
import { Message, type Model } from "./model"
import { aiGatewayPanel, realUsersPanel } from "./view-panels"
import { overviewRail } from "./view-rail"
import { type ChartContext, overviewStrips } from "./view-strips"
import { projectTable, projectTableLoading } from "./view-table"

// `VercelPage`: health first, then traffic against deploys, the projects, AI Gateway and real users.

type H = HtmlBuilder<Message>

const VERCEL_DESCRIPTION = "Traffic, errors, cache and deploys for every project on your Vercel team."

const VERCEL_ICON = (h: H) => icon(h, "VercelIcon", { size: 16, className: "text-foreground" })

/** The strips' status classes name `--chart-2`. */
const THEME_TOKENS = [...INFRA_CHART_TOKENS, "--chart-2"]

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

export type ListFrame = Readonly<{
	status: VercelIntegrationStatus
	time: TimeSearch
	clock: Clock
}>

const count = (healths: ReadonlyArray<ProjectHealth>, health: ProjectHealth) =>
	Arr.filter(healths, (h) => h === health).length

/** `VercelFleetBand`: counts over every project, whatever the table is filtered to. */
const band = (
	h: H,
	o: Overview,
	rows: NonNullable<Overview["rows"]>,
	active: VercelProjectScope | undefined,
): Html => {
	const healths = Arr.map(rows, (row) => projectHealth(row, o.window))
	const scoped = (scope: VercelProjectScope) =>
		Arr.filter(rows, (row) => inScope(row, scope, o.window)).length
	const erroring = count(healths, "erroring")
	const failed = count(healths, "failedDeploy")
	const idle = count(healths, "idle")
	return fleetBand<VercelProjectScope, Message>(h, {
		total: rows.length,
		noun: "project",
		caption: `${rows.length - erroring - failed - idle} healthy · ${failed} build failing · ${erroring} erroring · ${idle} idle`,
		segments: [
			{ key: "healthy", count: rows.length - erroring - failed - idle, className: TONE_FILL.ok },
			{ key: "failed deploy", count: failed, className: TONE_FILL.warn },
			{ key: "erroring", count: erroring, className: TONE_FILL.crit },
			{ key: "idle", count: idle, className: TONE_FILL.neutral },
		],
		cells: [
			{
				scope: "erroring",
				label: "Serving 5xx",
				hint: "≥ 1% of requests",
				value: scoped("erroring"),
				tone: "crit",
			},
			{
				scope: "failedDeploys",
				label: "Failed deploys",
				hint: "latest deploy failed",
				value: scoped("failedDeploys"),
				tone: "warn",
			},
			{ scope: "slow", label: "Slow", hint: "p95 ≥ 1s", value: scoped("slow"), tone: "warn" },
			{
				scope: "coldStarts",
				label: "Cold-start heavy",
				hint: "≥ 10% cold",
				value: scoped("coldStarts"),
				tone: "neutral",
			},
		],
		activeScope: active,
		onScopeChange: (scope) => Message.ClickedScope({ scope }),
		className: FLEET_BAND_BOXED,
	})
}

const table = (
	h: H,
	model: Model,
	o: Overview,
	rows: NonNullable<Overview["rows"]>,
	frame: ListFrame,
): Html => {
	const query = model.search.q ?? ""
	const q = Str.toLowerCase(Str.trim(query))
	const scope = model.search.scope
	const shown = Arr.filter(
		problemsFirst(rows, o.window),
		(row) =>
			(scope === undefined || inScope(row, scope, o.window)) &&
			(q === "" ||
				Str.includes(q)(Str.toLowerCase(`${row.name} ${row.framework ?? ""} ${row.projectId}`))),
	)
	return projectTable(h, {
		rows: Arr.map(shown, (row) => ({ row, health: projectHealth(row, o.window) })),
		total: rows.length,
		query,
		isFiltered: shown.length !== rows.length,
		notForwarded: Arr.map(
			Arr.filter(frame.status.projects, (project) => !project.forwarded),
			(project) => project.name,
		),
		time: frame.time,
		clock: frame.clock,
	})
}

const chartContext = (model: Model, timeZone: string): ChartContext | null =>
	model.themeColors === null || model.chartRuntime._tag === "Loading"
		? null
		: { theme: model.themeColors, timeZone }

/** `VercelOverview`'s main column: the fleet band, the strips, the projects and the two panels. */
export const listBody = (h: H, model: Model, frame: ListFrame): Html =>
	mainColumn(h, model, frame, overviewOf(model, frame.status))

const mainColumn = (h: H, model: Model, frame: ListFrame, o: Overview): Html => {
	const projectsFailure = failureOf(model.projects.data)
	const waiting = AsyncData.isRefreshing(model.projects.data)
	const content = (): ReadonlyArray<Html> => {
		if (projectsFailure !== null)
			return [
				errorState(h, {
					failure: projectsFailure,
					title: "Couldn't load Vercel projects",
					onRetry: Message.ClickedRetryProjects(),
				}),
			]
		if (o.rows === null) return [fleetBandLoading(h, 4, FLEET_BAND_BOXED), projectTableLoading(h)]
		if (o.rows.length === 0) return [noDataYet(h, frame.status)]
		return [
			band(h, o, o.rows, model.search.scope),
			...(frame.status.logsEnabled ? [] : [tracesOnlyNotice(h)]),
			...overviewStrips(h, model, o, chartContext(model, frame.clock.timeZone)),
			table(h, model, o, o.rows, frame),
			grid(h, { cols: 1, lg: 2, gap: "6" }, [aiGatewayPanel(h, model, o), realUsersPanel(h, model, o)]),
		]
	}
	return h.div(
		[h.Class(cn("space-y-6", refreshingClass(waiting))), ...(waiting ? [h.AriaBusy(true)] : [])],
		content(),
	)
}

const header = (h: H, status: VercelIntegrationStatus | null) => {
	const team = status?.team ?? null
	const drains =
		status === null || !status.connected
			? []
			: Arr.flatMap(VERCEL_DRAINS, (drain) =>
					status[drain.flag] ? [drainState(true, status.drains[drain.key])] : [],
				)
	const live = Arr.filter(drains, (state) => state.tone === "ok").length
	return pageHeroParts(h, {
		title: "Vercel",
		description: VERCEL_DESCRIPTION,
		trailing: [
			...(team === null
				? []
				: [
						heroChip(h, [
							team.name,
							...(team.plan === undefined || team.plan === null ? [] : [` · ${team.plan}`]),
						]),
					]),
			...(drains.length === 0
				? []
				: [
						heroChip(h, [
							hstack(h, { as: "span", gap: "1.5" }, [
								statusDot(h, { tone: live === drains.length ? "ok" : "warn" }),
								`${live} of ${drains.length} drains live`,
							]),
						]),
					]),
		],
	})
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

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const timeZone = inputs.context.timeZone
	const status = dataOf(model.status.data)
	const statusFailure = failureOf(model.status.data)
	const connected = status !== null && status.connected ? status : null
	const frame: ListFrame | null =
		connected === null
			? null
			: {
					status: connected,
					time: pickTimeSearch(model.search),
					clock: { nowMs: model.nowMs, timeZone },
				}
	const hero = header(h, status)
	const o = frame === null ? null : overviewOf(model, frame.status)
	const body =
		statusFailure !== null
			? errorState(h, {
					failure: statusFailure,
					title: "Couldn't load the Vercel connection",
					onRetry: Message.ClickedRetryStatus(),
				})
			: status === null
				? fleetBandLoading(h, 4, FLEET_BAND_BOXED)
				: frame === null || o === null
					? notConnected(h)
					: mainColumn(h, model, frame, o)
	return h.div(
		[h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: THEME_TOKENS }))],
		[
			dashboardPage(
				h,
				{
					gap: "lg",
					titleContent: hero.title,
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
					rightPanel:
						frame === null || o === null ? undefined : overviewRail(h, model, o, frame.clock),
				},
				[body],
			),
		],
	)
})
