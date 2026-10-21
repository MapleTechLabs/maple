import { formatBytes, formatRate } from "@maple/ui/lib/format"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { cn } from "@maple/ui/lib/utils"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { LoadFailure } from "../../../../data/load-failure"
import { AppRoute, hrefOf } from "../../../../route"
import { alert, alertAction, alertDescription, alertTitle } from "../../../../ui/alert"
import { linkButton } from "../../../../ui/button"
import { errorState } from "../../../../ui/error-state"
import { icon } from "../../../../ui/icon"
import { skeleton } from "../../../../ui/skeleton"
import type { PageViewInputs } from "../../../contract"
import { dashboardPage } from "../../../kit/dashboard-page"
import { filteredEmpty } from "../../../kit/signal-empty-state"
import { statRail, statRailItem } from "../../../kit/stat-rail"
import { countLabel, pageHero, searchToolbar } from "../../../infra/kit/page-parts"
import { integrationNotConnected } from "../../kit/empty-states"
import { pageTime } from "../../kit/page-time"
import { SUPABASE_CONNECT_HINT, SUPABASE_NOT_CONFIGURED, supabaseOnRamp } from "../connect"
import type { SupabaseProjectRow, SupabaseStatus } from "../model"
import { filterProjects, fleetSummary, projectViews } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { DEFAULT_PRESET } from "./update"
import { type Clock, supabaseTable, supabaseTableLoading } from "./view-table"

// `/infra/supabase`.

type H = HtmlBuilder<Message>

const CONNECT_HREF = hrefOf(AppRoute.SourcesNew({ search: { integration: "supabase" } }))

const connectLink = (h: H, label: string): Html =>
	linkButton(h, { href: CONNECT_HREF }, [icon(h, "SupabaseIcon"), label])

const loading = (h: H): Html =>
	h.div([h.Class("space-y-4")], [skeleton(h, "h-[74px] w-full rounded-md"), supabaseTableLoading(h)])

const band = (h: H, views: ReturnType<typeof projectViews>): Html => {
	const summary = fleetSummary(views)
	return statRail(h, { columns: 4 }, [
		statRailItem(h, { compact: true, eyebrow: "Projects", value: String(summary.total) }),
		statRailItem(h, {
			compact: true,
			eyebrow: "Collecting metrics",
			value: String(summary.collecting),
			subline: summary.waiting > 0 ? `${summary.waiting} waiting for a first scrape` : undefined,
		}),
		statRailItem(h, { compact: true, eyebrow: "Database size", value: formatBytes(summary.totalDbSize) }),
		statRailItem(h, {
			compact: true,
			eyebrow: "Avg connections",
			value: formatRate(summary.connections),
		}),
	])
}

const revokedNotice = (h: H): Html =>
	alert(h, { variant: "warn" }, [
		icon(h, "AlertWarningIcon"),
		alertTitle(h, ["Supabase access was revoked"]),
		alertDescription(h, ["Discovery and metrics are paused. Reconnect the organization to resume."]),
		alertAction(h, [
			linkButton(h, { size: "sm", variant: "outline", href: CONNECT_HREF }, ["Reconnect"]),
		]),
	])

const projectsList = (
	h: H,
	model: Model,
	status: SupabaseStatus,
	rows: ReadonlyArray<SupabaseProjectRow>,
	clock: Clock,
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
	const query = model.search.q ?? ""
	const filtered = filterProjects(views, query)
	return h.div(
		[h.Class(cn("space-y-4", refreshingClass(isWaiting))), ...(isWaiting ? [h.AriaBusy(true)] : [])],
		[
			...(status.revoked ? [revokedNotice(h)] : []),
			band(h, views),
			searchToolbar(h, {
				id: "supabase-search",
				value: query,
				placeholder: "Search projects…",
				onInput: (value) => Message.ChangedSearch({ value }),
				onClear: Message.ClickedClearSearch(),
				trailing:
					filtered.length === views.length
						? countLabel(views.length, views.length, "project")
						: `${filtered.length} of ${views.length} projects`,
			}),
			filtered.length === 0
				? filteredEmpty(h, { noun: "projects", description: "Clear the search to see them all." })
				: supabaseTable(h, { projects: filtered, sort: model.sort, clock }),
		],
	)
}

const projectsError = (h: H, failure: LoadFailure): Html =>
	errorState(h, {
		failure,
		title: "Failed to load Supabase metrics",
		onRetry: Message.ClickedRetryProjects(),
	})

const projectsView = (h: H, model: Model, status: SupabaseStatus, clock: Clock): Html =>
	AsyncData.match(model.projects.data, {
		onIdle: () => loading(h),
		onLoading: () => loading(h),
		onFailure: (failure) => projectsError(h, failure),
		onStale: ({ error }) => projectsError(h, error),
		onSuccess: (rows) => projectsList(h, model, status, rows, clock, false),
		onRefreshing: (rows) => projectsList(h, model, status, rows, clock, true),
	})

/** Not connected is the on-ramp: no placeholder data, ever. */
const byStatus = (h: H, model: Model, status: SupabaseStatus, clock: Clock): Html => {
	if (status.connected) return projectsView(h, model, status, clock)
	return status.configured
		? supabaseOnRamp(h, SUPABASE_CONNECT_HINT, connectLink(h, "Connect Supabase"))
		: supabaseOnRamp(h, SUPABASE_NOT_CONFIGURED, null)
}

const statusView = (h: H, model: Model, clock: Clock): Html =>
	AsyncData.match(model.status.data, {
		onIdle: () => loading(h),
		onLoading: () => loading(h),
		onFailure: (failure) =>
			errorState(h, {
				failure,
				title: "Failed to load the Supabase integration",
				onRetry: Message.ClickedRetryStatus(),
			}),
		onStale: ({ data }) => byStatus(h, model, data, clock),
		onSuccess: (data) => byStatus(h, model, data, clock),
		onRefreshing: (data) => byStatus(h, model, data, clock),
	})

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const clock = { nowMs: model.nowMs, timeZone: inputs.context.timeZone }
	return dashboardPage(
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
				description: "CPU, memory, disk and Postgres health for each Supabase project.",
			}),
			statusView(h, model, clock),
		],
	)
})
