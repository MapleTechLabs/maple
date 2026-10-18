import { GCP_INFRA_SERVICE_IDS, type GcpInfraServiceId } from "@maple/domain/gcp-infra"
import { GCP_CLOUD_SQL_INVENTORY_QUERY, gcpResourceQuery } from "@maple/web/components/infra/gcp/inventory"
import { gcpWorkloadKeys } from "@maple/web/components/infra/gcp/tabs"
import { Command } from "foldkit"
import * as Chart from "../../../../charts/chart"
import { LoadChartRuntime } from "../../../../charts/chart-runtime"
import { chartBucketSeconds } from "../../../../charts/infra-metric-series"
import * as Keyed from "../../../../data/keyed"
import { requestKey } from "../../../../data/request-key"
import type { Resources } from "../../../../platform/resources"
import { AppRoute, hrefOf } from "../../../../route"
import { type PageContext, PageOutMessage, type PageReturn } from "../../../contract"
import * as TimeRangePicker from "../../../kit/time-range-picker"
import { stepTimePicker, withPreset } from "../../kit/page-time"
import { requestSlot } from "../../kit/slot"
import type { OverviewInput, ResourcesQuery, TimeseriesInput } from "../data"
import {
	CompleteReloadSpin,
	FetchFleet,
	FetchNodes,
	FetchOverview,
	FetchResource,
	FetchSqlInventory,
	FetchTimeseries,
	FetchTopQueries,
	FetchTraceSide,
	ResolveWindow,
} from "./command"
import { Message, type Model, type RequestMode } from "./model"

type Return = PageReturn<Model, Message>
type Search = Model["search"]
type Route = { readonly service: string; readonly name: string; readonly search: Search }
type Commands = ReadonlyArray<Command.Command<Message, never, Resources>>

export const DEFAULT_PRESET = "1h"

export const keysOf = (model: Model): ReadonlyArray<string> =>
	gcpWorkloadKeys(model.service, model.name, model.search)

const resolveCommand = (model: Model, context: PageContext, mode: RequestMode) =>
	ResolveWindow({
		mode,
		startTime: model.search.startTime,
		endTime: model.search.endTime,
		preset: model.search.timePreset ?? DEFAULT_PRESET,
		timeZone: context.timeZone,
	})

const hrefOfSearch = (model: Model, search: Search) =>
	hrefOf(AppRoute.InfraGcpResource({ service: model.service, name: model.name, search }))

/** Every read of the page for the resolved window, keyed like the atoms. */
const requestAll = (model: Model, context: PageContext, mode: Keyed.RequestMode): Return => {
	const window = model.window
	if (window === null) return { model }
	const org = context.orgId
	const keys = keysOf(model)
	const bucketSeconds = chartBucketSeconds(window.startTime, window.endTime)
	const commands: Array<Commands[number]> = []
	const take = <A, E>(
		slot: Keyed.Keyed<A, E>,
		key: string,
		fetch: () => Commands[number],
		slotMode: Keyed.RequestMode = mode,
	): Keyed.Keyed<A, E> => {
		const [next, fetches] = requestSlot(slot, key, slotMode, fetch)
		commands.push(...fetches)
		return next
	}
	const isCloudSql = model.service === "cloudSql"
	const sqlInput = { ...window, keys }
	const sqlInventory = isCloudSql
		? take(
				model.sqlInventory,
				requestKey(org, "integrations.gcpResources", { query: GCP_CLOUD_SQL_INVENTORY_QUERY }),
				() =>
					FetchSqlInventory({
						key: requestKey(org, "integrations.gcpResources", {
							query: GCP_CLOUD_SQL_INVENTORY_QUERY,
						}),
						query: GCP_CLOUD_SQL_INVENTORY_QUERY,
					}),
				"Load",
			)
		: model.sqlInventory
	const topQueries = isCloudSql
		? take(model.topQueries, requestKey(org, "getGcpCloudSqlTopQueries", { data: sqlInput }), () =>
				FetchTopQueries({
					key: requestKey(org, "getGcpCloudSqlTopQueries", { data: sqlInput }),
					input: sqlInput,
				}),
			)
		: model.topQueries
	const traceSide = isCloudSql
		? take(model.traceSide, requestKey(org, "getGcpCloudSqlTraceSide", { data: sqlInput }), () =>
				FetchTraceSide({
					key: requestKey(org, "getGcpCloudSqlTraceSide", { data: sqlInput }),
					input: sqlInput,
				}),
			)
		: model.traceSide
	const fleet = isCloudSql
		? take(
				model.fleet,
				requestKey(org, "getGcpInfraFleet", { data: window }),
				() => FetchFleet({ key: requestKey(org, "getGcpInfraFleet", { data: window }), window }),
				"Load",
			)
		: model.fleet
	const seriesInput: TimeseriesInput = { ...window, bucketSeconds, source: model.service, keys }
	const timeseries = take(
		model.timeseries,
		requestKey(org, "getGcpInfraTimeseries", { data: seriesInput }),
		() =>
			FetchTimeseries({
				key: requestKey(org, "getGcpInfraTimeseries", { data: seriesInput }),
				input: seriesInput,
			}),
	)
	const query: ResourcesQuery = gcpResourceQuery(model.service, keys)
	const resource = take(
		model.resource,
		requestKey(org, "integrations.gcpResources", { query }),
		() => FetchResource({ key: requestKey(org, "integrations.gcpResources", { query }), query }),
		"Load",
	)
	const overviewInput: OverviewInput =
		context.pinnedNamespace === null
			? { ...window }
			: { ...window, namespaces: [context.pinnedNamespace] }
	const overview = take(
		model.overview,
		requestKey(org, "getServiceOverview", { data: overviewInput }),
		() =>
			FetchOverview({
				key: requestKey(org, "getServiceOverview", { data: overviewInput }),
				input: overviewInput,
			}),
	)
	const nodesInput: TimeseriesInput = { ...window, bucketSeconds, source: "gkeNodes", keys: keys.slice(2) }
	const nodes =
		model.service === "gke"
			? take(model.nodes, requestKey(org, "getGcpInfraTimeseries", { data: nodesInput }), () =>
					FetchNodes({
						key: requestKey(org, "getGcpInfraTimeseries", { data: nodesInput }),
						input: nodesInput,
					}),
				)
			: model.nodes
	return {
		model: {
			...model,
			sqlInventory,
			topQueries,
			traceSide,
			fleet,
			timeseries,
			resource,
			overview,
			nodes,
		},
		commands,
	}
}

const serviceOf = (service: string): GcpInfraServiceId | undefined =>
	GCP_INFRA_SERVICE_IDS.find((candidate) => candidate === service)

export const init = (route: Route, context: PageContext): Return => {
	const service = serviceOf(route.service)
	const model = initialModel(service ?? "cloudRun", route.name, route.search)
	// A mistyped service has no page: the list falls back to its first view.
	if (service === undefined) {
		return {
			model,
			outMessage: PageOutMessage.RequestedNavigation({
				url: hrefOf(AppRoute.InfraGcp({ search: {} })),
				isReplace: true,
			}),
		}
	}
	return {
		model,
		commands: [
			resolveCommand(model, context, "Load"),
			Command.mapMessage(LoadChartRuntime(), (message) =>
				message._tag === "CompletedLoadChartRuntime"
					? Message.CompletedLoadChartRuntime()
					: Message.FailedLoadChartRuntime({ reason: message.reason }),
			),
		],
	}
}

/** The page before any read: every slot idle, the chart runtime and theme still to come. */
export const initialModel = (service: GcpInfraServiceId, name: string, search: Search): Model => ({
	service,
	name,
	search,
	window: null,
	nowMs: 0,
	timeseries: Keyed.idle(),
	resource: Keyed.idle(),
	overview: Keyed.idle(),
	nodes: Keyed.idle(),
	sqlInventory: Keyed.idle(),
	topQueries: Keyed.idle(),
	traceSide: Keyed.idle(),
	fleet: Keyed.idle(),
	showAllQueries: false,
	charts: {},
	chartRuntime: { _tag: "Loading" },
	themeColors: null,
	timePicker: TimeRangePicker.init("gcp-workload-time-range"),
	refreshVersion: 0,
	isReloading: false,
})

export const routeChanged = (model: Model, route: Route, context: PageContext): Return => {
	if (hrefOfSearch(model, model.search) === hrefOfSearch(model, route.search)) return { model }
	const next = { ...model, search: route.search }
	return {
		model: next,
		commands: [resolveCommand(next, context, model.refreshVersion === 0 ? "Load" : "Refresh")],
	}
}

export const contextChanged = (model: Model, context: PageContext): Return =>
	requestAll(model, context, "Load")

const navigate = (model: Model, search: Search): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({ url: hrefOfSearch(model, search), isReplace: false }),
})

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedResolveWindow: ({ window, nowMs, mode }) =>
			requestAll({ ...model, window, nowMs }, context, mode),
		CompletedFetchTimeseries: ({ key, result }) => ({
			model: { ...model, timeseries: Keyed.accept(model.timeseries, key, result) },
		}),
		CompletedFetchResource: ({ key, result }) => ({
			model: { ...model, resource: Keyed.accept(model.resource, key, result) },
		}),
		CompletedFetchOverview: ({ key, result }) => ({
			model: { ...model, overview: Keyed.accept(model.overview, key, result) },
		}),
		CompletedFetchNodes: ({ key, result }) => ({
			model: { ...model, nodes: Keyed.accept(model.nodes, key, result) },
		}),
		CompletedFetchSqlInventory: ({ key, result }) => ({
			model: { ...model, sqlInventory: Keyed.accept(model.sqlInventory, key, result) },
		}),
		CompletedFetchTopQueries: ({ key, result }) => ({
			model: { ...model, topQueries: Keyed.accept(model.topQueries, key, result) },
		}),
		CompletedFetchTraceSide: ({ key, result }) => ({
			model: { ...model, traceSide: Keyed.accept(model.traceSide, key, result) },
		}),
		CompletedFetchFleet: ({ key, result }) => ({
			model: { ...model, fleet: Keyed.accept(model.fleet, key, result) },
		}),
		CompletedLoadChartRuntime: () => ({ model: { ...model, chartRuntime: { _tag: "Ready" } } }),
		FailedLoadChartRuntime: ({ reason }) => ({
			model: { ...model, chartRuntime: { _tag: "Failed", reason } },
		}),
		ResolvedThemeColors: ({ colors }) => ({ model: { ...model, themeColors: colors } }),
		AttachedLinkedCursor: () => ({ model }),
		ClickedRetryTimeseries: () => requestAll(model, context, "Refresh"),
		ClickedShowAllQueries: () => ({ model: { ...model, showAllQueries: !model.showAllQueries } }),
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
				(preset) => hrefOfSearch(model, withPreset(model.search, preset)),
			)
			return {
				model: { ...model, timePicker: step.timePicker },
				commands: step.commands,
				outMessage: step.outMessage,
			}
		},
		GotChartMessage: ({ chartId, message: inner }) => {
			const next = Chart.update(model.charts[chartId] ?? Chart.init(), inner)
			return {
				model: { ...model, charts: { ...model.charts, [chartId]: next.model } },
				commands: Command.mapMessages(next.commands ?? [], (chart) =>
					Message.GotChartMessage({ chartId, message: chart }),
				),
			}
		},
	})
