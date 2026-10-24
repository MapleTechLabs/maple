import {
	countLabel,
	EMPTY_VALUE,
	formatBytes,
	formatNumber,
	formatPercent,
	formatRate,
} from "@maple/ui/lib/format"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { LoadFailure } from "../../../../data/load-failure"
import { alert, alertAction, alertDescription, alertTitle } from "../../../../ui/alert"
import { linkButton } from "../../../../ui/button"
import { errorState } from "../../../../ui/error-state"
import { icon } from "../../../../ui/icon"
import type { PageViewInputs } from "../../../contract"
import { dashboardPage } from "../../../kit/dashboard-page"
import { statRail, statRailItem, statRailLoading } from "../../../kit/stat-rail"
import { pageHero } from "../../../infra/kit/page-parts"
import { integrationNotConnected } from "../../kit/empty-states"
import { pageTime } from "../../kit/page-time"
import { supabaseConnectCta } from "../connect"
import { ERROR_RATE_LIMIT } from "../health"
import type { SupabaseProjectRow, SupabaseStatus } from "../model"
import { MANAGE_HREF } from "../panel"
import { fleetSummary, type ProjectView, projectViews } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { DEFAULT_PRESET } from "./update"
import { advisorsPanel, issuesPanel } from "./view-bottom"
import { supabaseTable, supabaseTableLoading } from "./view-table"

// `/infra/supabase`: the organization's projects, their health and what needs a look.

type H = HtmlBuilder<Message>

const loading = (h: H): Html =>
	h.div([h.Class("space-y-4")], [statRailLoading(h, 4, 4), supabaseTableLoading(h)])

const LOGS_OFF = "Turn on logs for a project to count it"

const tiles = (h: H, views: ReadonlyArray<ProjectView>): Html => {
	const summary = fleetSummary(views)
	const more = summary.unhealthyCount > 1 ? ` and ${summary.unhealthyCount - 1} more` : ""
	return statRail(h, { columns: 4 }, [
		statRailItem(h, {
			compact: true,
			eyebrow: "Projects",
			value: `${summary.healthy} of ${summary.total} healthy`,
			tone: summary.unhealthyCount > 0 ? "warn" : undefined,
			subline:
				summary.firstReason !== null
					? `${summary.firstReason}${more}`
					: summary.unknown > 0
						? `${countLabel(summary.unknown, "project")} without metrics`
						: "Every project is healthy",
		}),
		statRailItem(h, {
			compact: true,
			eyebrow: "API requests",
			value: summary.hasLogs ? formatNumber(summary.requests) : EMPTY_VALUE,
			subline: summary.hasLogs
				? `5xx ${formatPercent(summary.errorRate5xx)} · ${formatRate(summary.requestsPerMinute)} req/min`
				: LOGS_OFF,
			tone: summary.errorRate5xx >= ERROR_RATE_LIMIT ? "crit" : undefined,
		}),
		statRailItem(h, {
			compact: true,
			eyebrow: "Errors and warnings",
			value: summary.hasLogs ? formatNumber(summary.issues) : EMPTY_VALUE,
			subline: summary.hasLogs ? `across ${countLabel(summary.issueProjects, "project")}` : LOGS_OFF,
		}),
		statRailItem(h, {
			compact: true,
			eyebrow: "Storage",
			value: formatBytes(summary.dbSize),
			subline: `across ${countLabel(summary.databases, "database")}`,
		}),
	])
}

const revokedNotice = (h: H): Html =>
	alert(h, { variant: "warn" }, [
		icon(h, "AlertWarningIcon"),
		alertTitle(h, ["Supabase access was revoked"]),
		alertDescription(h, [
			"Discovery, metrics and logs are paused. Reconnect the organization to resume.",
		]),
		alertAction(h, [linkButton(h, { size: "sm", variant: "outline", href: MANAGE_HREF }, ["Reconnect"])]),
	])

const overview = (
	h: H,
	model: Model,
	status: SupabaseStatus,
	rows: ReadonlyArray<SupabaseProjectRow>,
	isWaiting: boolean,
): Html => {
	const views = projectViews(status, rows)
	if (views.length === 0)
		return integrationNotConnected(h, {
			icon: icon(h, "SupabaseIcon", { size: 16 }),
			title: "No Supabase projects yet",
			description:
				"Projects in the connected organization show up here. Create one in Supabase, then sync.",
			integration: "supabase",
			actionLabel: "Check the connection",
			actionVariant: "outline",
		})
	const names = new Map(views.map((view) => [view.ref, view.displayName]))
	return h.div(
		[h.Class("space-y-4")],
		[
			...(status.revoked ? [revokedNotice(h)] : []),
			tiles(h, views),
			supabaseTable(h, views, isWaiting),
			h.div(
				[h.Class("grid grid-cols-1 gap-4 lg:grid-cols-2")],
				[
					issuesPanel(h, model, { names, hasLogs: views.some((view) => view.logsEnabled) }),
					advisorsPanel(h, model, { names, total: status.projects.length }),
				],
			),
		],
	)
}

const projectsError = (h: H, failure: LoadFailure): Html =>
	errorState(h, {
		failure,
		title: "Failed to load Supabase metrics",
		onRetry: Message.ClickedRetryProjects(),
	})

const projectsView = (h: H, model: Model, status: SupabaseStatus): Html =>
	AsyncData.match(model.projects.data, {
		onIdle: () => loading(h),
		onLoading: () => loading(h),
		onFailure: (failure) => projectsError(h, failure),
		onStale: ({ error }) => projectsError(h, error),
		onSuccess: (rows) => overview(h, model, status, rows, false),
		onRefreshing: (rows) => overview(h, model, status, rows, true),
	})

/** Not connected is the on-ramp: no placeholder data, ever. */
const byStatus = (h: H, model: Model, status: SupabaseStatus): Html => {
	return status.connected ? projectsView(h, model, status) : supabaseConnectCta(h, status.configured)
}

const statusView = (h: H, model: Model): Html =>
	AsyncData.match(model.status.data, {
		onIdle: () => loading(h),
		onLoading: () => loading(h),
		onFailure: (failure) =>
			errorState(h, {
				failure,
				title: "Failed to load the Supabase integration",
				onRetry: Message.ClickedRetryStatus(),
			}),
		onStale: ({ data }) => byStatus(h, model, data),
		onSuccess: (data) => byStatus(h, model, data),
		onRefreshing: (data) => byStatus(h, model, data),
	})

/** "Acme organization · 4 projects · metrics and logs every minute", once connected. */
const description = (model: Model): string => {
	const status = AsyncData.getData(model.status.data)
	if (status._tag === "None" || !status.value.connected)
		return "CPU, memory, disk, Postgres health, API traffic and logs for each Supabase project."
	const org = status.value.organization
	return [
		...(org === null ? [] : [`${org.name} organization`]),
		countLabel(status.value.projects.length, "project"),
		"metrics and logs every minute",
	].join(" · ")
}

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, _inputs, h) =>
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
		[
			pageHero(h, {
				title: "Supabase",
				description: description(model),
				actions: [
					linkButton(h, { size: "sm", variant: "outline", href: MANAGE_HREF }, ["Manage projects"]),
				],
			}),
			statusView(h, model),
		],
	),
)
