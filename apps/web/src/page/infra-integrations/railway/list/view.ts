import { formatBytes } from "@maple/ui/lib/format"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { toEpochMs } from "@maple/ui/lib/time-format"
import { cn } from "@maple/ui/lib/utils"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { LoadFailure } from "../../../../data/load-failure"
import { errorState } from "../../../../ui/error-state"
import { icon } from "../../../../ui/icon"
import * as Tooltip from "../../../../ui/tooltip"
import type { PageViewInputs } from "../../../contract"
import { dashboardPage } from "../../../kit/dashboard-page"
import { timeControls } from "../../../kit/time-controls"
import * as TimeRangePicker from "../../../kit/time-range-picker"
import { integrationNotConnected } from "../../kit/empty-states"
import { RAILWAY_ACCENT } from "../../../integrations/catalog"
import { integrationConnectCta } from "../../kit/integration-empty"
import { AppRoute, hrefOf } from "../../../../route"
import { filteredEmpty } from "../../../kit/signal-empty-state"
import { avgPeakContent } from "../../../infra/kit/avg-peak"
import { pageHeroParts, countLabel, searchToolbar } from "../../../infra/kit/page-parts"
import { formatAbsolute } from "../../../kit/relative-time"
import type { RailwayServiceRow, RailwayStatus } from "../model"
import { filterServices, formatVcpu, hasConfiguredLimits, unsyncedEnvironments } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { DEFAULT_PRESET } from "./update"
import { railwayFleetBand, railwayFleetBandLoading } from "./view-band"
import { type Clock, railwayTable, railwayTableLoading, triggerIds } from "./view-table"

// `RailwayPage`.

type H = HtmlBuilder<Message>

const NOTE = "Summed across replicas."

/** The row tooltip's body for the trigger it is anchored to. */
const tooltipContent = (
	h: H,
	services: ReadonlyArray<RailwayServiceRow>,
	clock: Clock,
	triggerId: string,
): ReadonlyArray<Html | string> =>
	services.flatMap((row): ReadonlyArray<Html | string> => {
		const ids = triggerIds(row)
		if (triggerId === ids.memory)
			return [
				avgPeakContent(h, {
					avg: row.memoryAvg,
					peak: row.memoryMax,
					format: formatBytes,
					note: NOTE,
				}),
			]
		if (triggerId === ids.cpu)
			return [avgPeakContent(h, { avg: row.cpuAvg, peak: row.cpuMax, format: formatVcpu, note: NOTE })]
		if (triggerId === ids.seen) return [formatAbsolute(toEpochMs(row.lastSeen), clock.timeZone)]
		return []
	})

const servicesView = (h: H, model: Model, status: RailwayStatus, clock: Clock): Html => {
	const slot = model.services.data
	const syncing = !status.authFailed && unsyncedEnvironments(status.environments) > 0
	return AsyncData.match(slot, {
		onIdle: () => servicesLoading(h),
		onLoading: () => servicesLoading(h),
		onFailure: (error) => servicesError(h, error),
		onStale: ({ error }) => servicesError(h, error),
		onSuccess: (data) => servicesList(h, model, status, data, clock, false, syncing),
		onRefreshing: (data) => servicesList(h, model, status, data, clock, true, syncing),
	})
}

const servicesError = (h: H, failure: LoadFailure): Html =>
	errorState(h, {
		failure,
		title: "Couldn't load Railway services",
		onRetry: Message.ClickedRetryServices(),
	})

const servicesLoading = (h: H): Html =>
	h.div([h.Class("space-y-4")], [railwayFleetBandLoading(h), railwayTableLoading(h)])

export const servicesList = (
	h: H,
	model: Model,
	status: RailwayStatus,
	services: ReadonlyArray<RailwayServiceRow>,
	clock: Clock,
	isWaiting: boolean,
	syncing: boolean,
): Html => {
	if (services.length === 0) {
		return integrationNotConnected(h, {
			icon: icon(h, "RailwayIcon", { size: 16 }),
			title: syncing ? "Pulling your Railway metrics" : "No Railway metrics in this window",
			description: syncing
				? "Some environments haven't finished their first sync. This page updates on its own as they land."
				: "Services that ran in this window show up here. Try a wider time range, or check the connection for errors.",
			integration: "railway",
			actionLabel: "Check the connection",
			actionVariant: "outline",
		})
	}
	const query = model.search.q ?? ""
	const filtered = filterServices(services, query)
	return h.submodel({
		slotId: "railway-row-tooltip",
		model: model.rowTooltip,
		view: Tooltip.view,
		toParentMessage: (message) => Message.GotRowTooltipMessage({ message }),
		viewInputs: {
			triggerIds: filtered.flatMap((row) => Object.values(triggerIds(row))),
			toContent: (triggerId) => tooltipContent(h, filtered, clock, triggerId),
			toView: ({ trigger, portal }) =>
				h.div(
					[
						h.Class(cn("space-y-4", refreshingClass(isWaiting))),
						...(isWaiting ? [h.AriaBusy(true)] : []),
					],
					[
						railwayFleetBand(h, {
							services,
							environments: status.environments,
							authFailed: status.authFailed,
							...clock,
						}),
						searchToolbar(h, {
							id: "railway-search",
							value: query,
							placeholder: "Search services…",
							onInput: (value) => Message.ChangedSearch({ value }),
							onClear: Message.ClickedClearSearch(),
							trailing:
								filtered.length === services.length
									? countLabel(services.length, services.length, "service")
									: `${filtered.length} of ${services.length} services`,
						}),
						filtered.length === 0
							? filteredEmpty(h, {
									noun: "services",
									description: "Clear the search to see them all.",
								})
							: railwayTable(h, {
									services: filtered,
									environments: status.environments,
									authFailed: status.authFailed,
									showLimits: hasConfiguredLimits(services),
									sort: model.sort,
									clock,
									trigger,
								}),
						...(portal === null ? [] : [portal]),
					],
				),
		},
	})
}

const FEATURES = [
	{
		label: "Resources",
		title: "CPU and memory per replica",
		description: "Usage against limits for every service, sampled each minute.",
	},
	{
		label: "Network & disk",
		title: "Traffic and volumes",
		description: "Network in and out, volume and ephemeral disk usage.",
	},
	{
		label: "Correlation",
		title: "Next to your traces",
		description: "Metrics carry the Railway service name, so they line up with your telemetry.",
	},
]

/** Nothing connected: what this page will show, and the way to the connect flow. */
const railwayConnectCta = (h: H): Html =>
	integrationConnectCta(h, {
		brand: { icon: "RailwayIcon", accent: RAILWAY_ACCENT, iconClassName: "text-foreground" },
		features: FEATURES,
		hint: "Connecting pulls the last hour of metrics right away, then Maple keeps it fresh every 5 minutes.",
		label: "Connect Railway",
		href: hrefOf(AppRoute.SourcesNew({ search: { integration: "railway" } })),
	})

/** `RailwayIntegrationCard` keeps the last loaded status when a refetch fails. */
const connectedView = (h: H, model: Model, status: RailwayStatus, clock: Clock): Html =>
	status.connected ? servicesView(h, model, status, clock) : railwayConnectCta(h)

const statusView = (h: H, model: Model, clock: Clock): Html =>
	AsyncData.match(model.status.data, {
		onIdle: () => railwayFleetBandLoading(h),
		onLoading: () => railwayFleetBandLoading(h),
		onFailure: (failure) => errorState(h, { failure }),
		onStale: ({ data }) => connectedView(h, model, data, clock),
		onSuccess: (data) => connectedView(h, model, data, clock),
		onRefreshing: (data) => connectedView(h, model, data, clock),
	})

const toTimePicker = (message: TimeRangePicker.Message) => Message.GotTimePickerMessage({ message })

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const clock = { nowMs: model.nowMs, timeZone: inputs.context.timeZone }
	const hero = pageHeroParts(h, {
		title: "Railway",
		description:
			"CPU, memory, network and disk for every Railway service, polled from Railway's metrics API.",
	})
	return dashboardPage(
		h,
		{
			gap: "lg",
			titleContent: hero.title,
			actions: timeControls(h, {
				search: model.search,
				defaultPreset: DEFAULT_PRESET,
				window: model.window,
				onReset: Message.ClickedResetTimeRange(),
				onReload: Message.ClickedReload(),
				isReloading: model.isReloading,
				trigger: (label) =>
					h.submodel({
						slotId: "time-range-picker",
						model: model.timePicker,
						view: TimeRangePicker.view,
						toParentMessage: toTimePicker,
						viewInputs: {
							label,
							selectedPreset:
								model.search.timePreset ??
								(model.search.startTime === undefined ? DEFAULT_PRESET : undefined),
							presets: TimeRangePicker.PRESET_VALUES,
						},
					}),
			}),
		},
		[hero.body, statusView(h, model, clock)],
	)
})
