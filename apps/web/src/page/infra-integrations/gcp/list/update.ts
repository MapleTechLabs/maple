import { GCP_CLOUD_SQL_INVENTORY_QUERY } from "../../../../components/infra/gcp/inventory"
import { gcpSparklineServices } from "../../../../components/infra/gcp/list-model"
import { AsyncData, Command } from "foldkit"
import { LoadChartRuntime } from "../../../../charts/chart-runtime"
import * as Keyed from "../../../../data/keyed"
import { requestSlot } from "../../kit/slot"
import { requestKey } from "../../../../data/request-key"
import type { Resources } from "../../../../platform/resources"
import { AppRoute, hrefOf } from "../../../../route"
import * as Menu from "../../../../ui/menu"
import * as Select from "../../../../ui/select"
import { type PageContext, PageOutMessage, type PageReturn } from "../../../contract"
import { routeWindowStep, snapModeOf } from "../../../kit/route-window"
import * as TimeRangePicker from "../../../kit/time-range-picker"
import { stepTimePicker, withPreset } from "../../kit/page-time"
import type { ResourcesQuery } from "../data"
import {
	CompleteReloadSpin,
	FetchCloudSqlInventory,
	FetchFleet,
	FetchResources,
	FetchSparks,
	LoadStatus,
	ResolveWindow,
} from "./command"
import { stepProjectMenu } from "./project-menu"
import { fleetOf, listScopeOf, pageStateOf, sparksWindow, statusOf } from "./derive"
import { INITIAL_LOCALE } from "../../../kit/locale"
import { Message, type Model, type RequestMode } from "./model"

type Return = PageReturn<Model, Message>
type Search = Model["search"]

export const DEFAULT_PRESET = "1h"

const resolveCommand = (model: Model, context: PageContext, mode: RequestMode) =>
	ResolveWindow({
		mode,
		startTime: model.search.startTime,
		endTime: model.search.endTime,
		preset: model.search.timePreset ?? DEFAULT_PRESET,
		timeZone: context.timeZone,
	})

const hrefOfSearch = (search: Search) => hrefOf(AppRoute.InfraGcp({ search }))

/** A view of its own replaces a link's old `?tab=`, and starts unscoped and unsearched. */
const viewSearch = (search: Search, view: string): Search => ({
	...search,
	view,
	tab: undefined,
	scope: undefined,
	q: undefined,
})

/** The view tab's link: where `ClickedView` navigates. */
export const viewHref = (search: Search, view: string): string => hrefOfSearch(viewSearch(search, view))

const navigate = (model: Model, search: Search): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({ url: hrefOfSearch(search), isReplace: false }),
})

const slot = requestSlot

/** The Resources view's query: an empty param is no filter. */
export const resourcesQueryOf = (search: Search): ResourcesQuery => {
	const typed: ResourcesQuery =
		search.type === undefined || search.type === "" ? {} : { assetType: search.type }
	return search.project === undefined || search.project === ""
		? typed
		: { ...typed, projectId: search.project }
}

/**
 * Every read the page shows right now, keyed like the atoms: the fleet once the status says it
 * collects, then the current view's sparklines, its Cloud SQL inventory, or the resource list.
 */
const sync = (model: Model, context: PageContext, mode: Keyed.RequestMode): Return => {
	const status = statusOf(model)
	const window = model.window
	if (status === null || window === null) return { model }
	const state = pageStateOf(status, model.nowMs)
	if (state._tag !== "Infra") return { model }
	const org = context.orgId
	const fleetKey = requestKey(org, "getGcpInfraFleet", { data: window })
	const [fleet, fleetCommands] = slot(model.fleet, fleetKey, mode, () =>
		FetchFleet({ key: fleetKey, window }),
	)
	const withFleet = { ...model, fleet }
	const loadedFleet = fleetOf(withFleet)
	const failed = AsyncData.isFailure(withFleet.fleet.data) || AsyncData.isStale(withFleet.fleet.data)
	const off = state.connectors.length === 0 && loadedFleet !== null && loadedFleet.length === 0
	if (failed || off) return { model: withFleet, commands: fleetCommands }
	const { view } = listScopeOf(withFleet, state.connectors.length > 0)
	// The view is settled only once the fleet lands: no sparklines for a view it may leave.
	const services = loadedFleet === null ? [] : gcpSparklineServices(view)
	const sparksInput = { ...sparksWindow(window), services }
	const sparksKey = requestKey(org, "getGcpInfraSparklines", { data: sparksInput })
	const [sparks, sparkCommands] =
		services.length === 0
			? ([withFleet.sparks, []] as const)
			: slot(withFleet.sparks, sparksKey, mode, () =>
					FetchSparks({ key: sparksKey, input: sparksInput }),
				)
	const sqlKey = requestKey(org, "integrations.gcpResources", { query: GCP_CLOUD_SQL_INVENTORY_QUERY })
	const [cloudSqlInventory, sqlCommands] =
		view === "cloudSql"
			? slot(withFleet.cloudSqlInventory, sqlKey, "Load", () =>
					FetchCloudSqlInventory({ key: sqlKey, query: GCP_CLOUD_SQL_INVENTORY_QUERY }),
				)
			: ([withFleet.cloudSqlInventory, []] as const)
	const query = resourcesQueryOf(model.search)
	const resourcesKey = requestKey(org, "integrations.gcpResources", { query })
	const [resources, resourceCommands] =
		view === "resources"
			? slot(withFleet.resources, resourcesKey, mode, () =>
					FetchResources({ key: resourcesKey, query }),
				)
			: ([withFleet.resources, []] as const)
	return {
		model: { ...withFleet, sparks, cloudSqlInventory, resources },
		commands: [...fleetCommands, ...sparkCommands, ...sqlCommands, ...resourceCommands],
	}
}

const statusKey = (context: PageContext) => requestKey(context.orgId, "gcpIntegration.status", {})

export const init = (route: { readonly search: Search }, context: PageContext): Return => {
	const key = statusKey(context)
	const model: Model = {
		search: route.search,
		window: null,
		nowMs: 0,
		locale: INITIAL_LOCALE,
		status: { key, data: AsyncData.Loading() },
		fleet: Keyed.idle(),
		sparks: Keyed.idle(),
		cloudSqlInventory: Keyed.idle(),
		resources: Keyed.idle(),
		resourceTypeSelect: Select.init("gcp-resource-type", { value: "all", selectedIndex: 0 }),
		resourceProjectSelect: Select.init("gcp-resource-project", { value: "all", selectedIndex: 0 }),
		projectMenu: Menu.init("gcp-project-menu"),
		chartRuntime: { _tag: "Loading" },
		themeColors: null,
		timePicker: TimeRangePicker.init("gcp-time-range"),
		refreshVersion: 0,
		isReloading: false,
	}
	return {
		model,
		commands: [
			resolveCommand(model, context, "Load"),
			LoadStatus({ key, refresh: false }),
			Command.mapMessage(LoadChartRuntime(), (message) =>
				message._tag === "CompletedLoadChartRuntime"
					? Message.CompletedLoadChartRuntime()
					: Message.FailedLoadChartRuntime({ reason: message.reason }),
			),
		],
	}
}

export const routeChanged = (
	model: Model,
	route: { readonly search: Search },
	context: PageContext,
): Return => {
	if (hrefOfSearch(model.search) === hrefOfSearch(route.search)) return { model }
	const next = { ...model, search: route.search }
	const resolve = (): Return => {
		const synced = sync(next, context, "Load")
		return {
			model: synced.model,
			commands: [
				resolveCommand(next, context, snapModeOf(model.refreshVersion)),
				...(synced.commands ?? []),
			],
		}
	}
	return routeWindowStep(model.search, route.search, {
		resolve,
		requestAll: (mode) => (next.window === null ? resolve() : sync(next, context, mode)),
	})
}

export const contextChanged = (model: Model): Return => ({ model })

const lift = <S, I>(
	model: Model,
	next: { readonly model: S; readonly commands?: ReadonlyArray<Command.Command<I, never, Resources>> },
	patch: (state: S) => Partial<Model>,
	wrap: (message: I) => Message,
): Return => ({
	model: { ...model, ...patch(next.model) },
	commands: Command.mapMessages(next.commands ?? [], wrap),
})

/** A resource filter Select picked a value: "all" leaves the URL. */
const resourceFilter = (model: Model, key: "type" | "project", value: string): Return =>
	navigate(model, { ...model.search, [key]: value === "all" ? undefined : value })

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedResolveWindow: ({ window, nowMs, locale, mode }) =>
			sync({ ...model, window, nowMs, locale }, context, mode),
		CompletedLoadStatus: ({ key, result }) =>
			sync({ ...model, status: Keyed.accept(model.status, key, result) }, context, "Load"),
		CompletedFetchFleet: ({ key, result }) =>
			sync({ ...model, fleet: Keyed.accept(model.fleet, key, result) }, context, "Load"),
		CompletedFetchSparks: ({ key, result }) => ({
			model: { ...model, sparks: Keyed.accept(model.sparks, key, result) },
		}),
		CompletedFetchCloudSqlInventory: ({ key, result }) => ({
			model: { ...model, cloudSqlInventory: Keyed.accept(model.cloudSqlInventory, key, result) },
		}),
		CompletedFetchResources: ({ key, result }) => ({
			model: { ...model, resources: Keyed.accept(model.resources, key, result) },
		}),
		CompletedLoadChartRuntime: () => ({ model: { ...model, chartRuntime: { _tag: "Ready" } } }),
		FailedLoadChartRuntime: ({ reason }) => ({
			model: { ...model, chartRuntime: { _tag: "Failed", reason } },
		}),
		ResolvedThemeColors: ({ colors }) => ({ model: { ...model, themeColors: colors } }),
		TickedStatusRefresh: () => {
			const key = statusKey(context)
			const [status, commands] = slot(model.status, key, "Refresh", () =>
				LoadStatus({ key, refresh: true }),
			)
			return { model: { ...model, status }, commands }
		},
		ClickedRetryStatus: () => {
			const key = statusKey(context)
			const [status, commands] = slot(model.status, key, "Refresh", () =>
				LoadStatus({ key, refresh: true }),
			)
			return { model: { ...model, status }, commands }
		},
		TickedFleetRefresh: () => sync(model, context, "Refresh"),
		TickedLiveClock: ({ nowMs }) => sync({ ...model, nowMs }, context, "Load"),
		ClickedRetryFleet: () => sync(model, context, "Refresh"),
		TickedResourcesRefresh: () => {
			const query = resourcesQueryOf(model.search)
			const key = requestKey(context.orgId, "integrations.gcpResources", { query })
			const [resources, commands] = slot(model.resources, key, "Refresh", () =>
				FetchResources({ key, query }),
			)
			return { model: { ...model, resources }, commands }
		},
		ClickedRetryResources: () => {
			const query = resourcesQueryOf(model.search)
			const key = requestKey(context.orgId, "integrations.gcpResources", { query })
			const [resources, commands] = slot(model.resources, key, "Refresh", () =>
				FetchResources({ key, query }),
			)
			return { model: { ...model, resources }, commands }
		},
		ClickedView: ({ view }) => navigate(model, viewSearch(model.search, view)),
		ClickedScope: ({ scope }) => navigate(model, { ...model.search, scope }),
		ChangedSearch: ({ value }) =>
			navigate(model, { ...model.search, q: value === "" ? undefined : value }),
		ClickedClearSearch: () => navigate(model, { ...model.search, q: undefined }),
		SelectedProject: ({ project }) => navigate(model, { ...model.search, project, scope: undefined }),
		ClickedClearRegion: () => navigate(model, { ...model.search, region: undefined, scope: undefined }),
		ClickedReload: () => {
			const reloaded = { ...model, refreshVersion: model.refreshVersion + 1, isReloading: true }
			return {
				model: reloaded,
				commands: [
					resolveCommand(reloaded, context, "Refresh"),
					CompleteReloadSpin({ version: reloaded.refreshVersion }),
				],
			}
		},
		ClickedResetTimeRange: () => navigate(model, withPreset(model.search, DEFAULT_PRESET)),
		CompletedReloadSpin: ({ version }) =>
			version === model.refreshVersion ? { model: { ...model, isReloading: false } } : { model },
		GotTimePickerMessage: ({ message: inner }) => {
			const step = stepTimePicker(
				model.timePicker,
				inner,
				(picker) => Message.GotTimePickerMessage({ message: picker }),
				(preset) => hrefOfSearch(withPreset(model.search, preset)),
			)
			return {
				model: { ...model, timePicker: step.timePicker },
				commands: step.commands,
				outMessage: step.outMessage,
			}
		},
		// Sparklines draw no focus or tooltip: their chart state is never read.
		GotSparklineMessage: () => ({ model }),
		GotResourceTypeSelectMessage: ({ message: inner }) => {
			const next = Select.update(model.resourceTypeSelect, inner)
			const lifted = lift(
				model,
				next,
				(resourceTypeSelect) => ({ resourceTypeSelect }),
				(m) => Message.GotResourceTypeSelectMessage({ message: m }),
			)
			return next.outMessage === undefined
				? lifted
				: { ...lifted, outMessage: resourceFilter(model, "type", next.outMessage.value).outMessage }
		},
		GotProjectMenuMessage: ({ message: inner }) => {
			const step = stepProjectMenu(model.projectMenu, inner)
			const next = { ...model, projectMenu: step.menu }
			const pick = step.pick
			if (pick === null) return { model: next, commands: step.commands }
			const outMessage = PageOutMessage.RequestedNavigation({
				url:
					pick._tag === "Project"
						? hrefOfSearch({ ...model.search, project: pick.project, scope: undefined })
						: hrefOf(AppRoute.SourcesNew({ search: { integration: "gcp" } })),
				isReplace: false,
			})
			return { model: next, commands: step.commands, outMessage }
		},
		GotResourceProjectSelectMessage: ({ message: inner }) => {
			const next = Select.update(model.resourceProjectSelect, inner)
			const lifted = lift(
				model,
				next,
				(resourceProjectSelect) => ({ resourceProjectSelect }),
				(m) => Message.GotResourceProjectSelectMessage({ message: m }),
			)
			return next.outMessage === undefined
				? lifted
				: {
						...lifted,
						outMessage: resourceFilter(model, "project", next.outMessage.value).outMessage,
					}
		},
	})
