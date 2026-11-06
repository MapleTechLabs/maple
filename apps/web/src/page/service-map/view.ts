import { DB_NODE_PREFIX, parseDbNodeId } from "@maple/ui/components/service-map/service-map-utils"
import { Option, Array as Arr, String as Str } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { serviceMapLoading } from "@maple/views/service-map/map/loading"
import * as ServiceMap from "@maple/views/service-map/map/service-map"
import { view as mapView } from "@maple/views/service-map/map/view"
import { alert, alertDescription } from "@maple/views/ui/alert"
import { errorState } from "@maple/views/ui/error-state"
import { segmentedSelect } from "@maple/views/ui/segmented-select"
import type * as Select from "@maple/views/ui/select"
import * as SelectView from "@maple/views/ui/select-view"
import type { PageViewInputs } from "../contract"
import { dashboardPage } from "../kit/dashboard-page"
import { timeControls } from "../kit/time-controls"
import * as TimeRangePicker from "../kit/time-range-picker"
import {
	DEFAULT_PRESET,
	durationSecondsOf,
	environmentItems,
	type ScopedRows,
	scopedRows,
	selectedEnvironment,
} from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { ResolveThemeColors } from "@maple/views/charts/theme-colors"
import { DB_CHART_TOKENS } from "./view-db-charts"
import { databasePanel } from "./view-db-panel"
import { serviceMapEmptyState } from "./view-empty"
import type * as Scene3d from "./scene3d"
import { scene3dView } from "./view-scene3d"
import { servicePanel } from "@maple/views/service-map/panel/service-panel"
import { infrastructureTab } from "./view-service-infra"
import { pickTimeSearch } from "../infra/kit/view-tabs"
import { AppRoute, hrefOf } from "../../route"
import { hstack } from "@maple/views/ui/stack"

type H = HtmlBuilder<Message>

const VIEW_OPTIONS = [
	{ value: "2d", label: "2D" },
	{ value: "3d", label: "3D" },
] as const

const toTimePicker = (message: TimeRangePicker.Message) => Message.GotTimePickerMessage({ message })
const toSelect = (message: Select.Message) => Message.GotEnvironmentSelectMessage({ message })

/** The header: view switch, environment and time controls; wraps, the select takes its own row when narrow. */
const headerActions = (h: H, model: Model): Html => {
	const controls = timeControls(h, {
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
					presets: TimeRangePicker.LONG_RANGE_PRESET_VALUES,
				},
			}),
	})
	const views = segmentedSelect<"2d" | "3d", Message>(h, {
		size: "sm",
		ariaLabel: "Service map view",
		options: VIEW_OPTIONS,
		value: model.search.view ?? "2d",
		onChange: (view) => Message.ClickedView({ view }),
	})
	return h.submodel({
		slotId: "environment-select",
		// The value follows the URL and facets (`selectedEnvironment`), not the trigger's last pick.
		model: { ...model.environmentSelect, value: selectedEnvironment(model) },
		view: SelectView.view,
		toParentMessage: toSelect,
		viewInputs: {
			entries: Arr.map(environmentItems(model), (item): SelectView.SelectEntry => ({
				_tag: "Item",
				item,
			})),
			size: "sm",
			// Sized to its value like the Overview select; full width only on its own narrow row.
			className: "w-full min-w-0 @2xl/page:w-auto",
			// `SelectValue` shows the raw value when it is not among the items (facets not loaded).
			renderValue: (value) => [
				Option.match(
					Arr.findFirst(environmentItems(model), (item) => item.value === value),
					{ onNone: () => value, onSome: (item) => item.label },
				),
			],
			toView: (parts) => hstack(h, { gap: "2", wrap: true }, [views, ...parts, controls]),
		},
	})
}

const toMap = (message: ServiceMap.Message) => Message.GotMapMessage({ message })

/** The shared service panel, with the Infrastructure tab only the dashboard can back. */
const serviceDetail = (
	h: H,
	model: Model,
	rows: ScopedRows,
	durationSeconds: number,
	map: ServiceMap.Model,
	serviceId: string,
): Html => {
	const workloads = Arr.filter(rows.workloads, (workload) => workload.serviceName === serviceId)
	const runtimes = Arr.filter(rows.runtimes, (runtime) => runtime.serviceName === serviceId)
	return servicePanel(h, {
		serviceId,
		map,
		overviews: rows.overviews,
		edges: rows.edges,
		platform: Option.getOrUndefined(
			Option.map(
				Arr.findFirst(rows.platforms, (row) => row.serviceName === serviceId),
				(row) => row.platform,
			),
		),
		durationSeconds,
		dbEdges: rows.dbEdges,
		serviceHref: (serviceName) => hrefOf(AppRoute.Service({ serviceName, search: {} })),
		// Span scope: most services never own a trace's root span.
		tracesHref: hrefOf(AppRoute.Traces({ search: { services: [serviceId], rootOnly: false } })),
		toMapMessage: toMap,
		infrastructure: {
			tabs: model.serviceTabs,
			toTabsMessage: (message) => Message.GotServiceTabsMessage({ message }),
			count: workloads.length + runtimes.length,
			content: () => infrastructureTab(h, workloads, runtimes, pickTimeSearch(model.search)),
		},
	})
}

/** `renderDetailPanel`: a database node gets its panel, anything else the service panel. */
const detailPanel =
	(
		h: H,
		model: Model,
		rows: ScopedRows,
		durationSeconds: number,
		map: ServiceMap.Model,
		timeZone: string,
	) =>
	(selectedId: string): Html => {
		if (!Str.startsWith(DB_NODE_PREFIX)(selectedId))
			return serviceDetail(h, model, rows, durationSeconds, map, selectedId)
		const node = Option.getOrUndefined(
			Arr.findFirst(map.source.rawNodes, (candidate) => candidate.id === selectedId),
		)
		return databasePanel(h, model, {
			nodeId: selectedId,
			...parseDbNodeId(selectedId),
			planetscale: node?.data.planetscale,
			rows,
			durationSeconds,
			timeZone,
		})
	}

const toScene3d = (message: Scene3d.Message) => Message.GotScene3dMessage({ message })

/** The API dropped the database edges past their budget: say so rather than draw a map with no databases. */
const dbEdgesTimedOutNotice = (h: H, model: Model): ReadonlyArray<Html> =>
	Option.match(AsyncData.getData(model.bundle.data), {
		onNone: () => [],
		onSome: (bundle) =>
			bundle.value.dbEdgesTimedOut
				? [
						alert(h, { variant: "warn", size: "sm", role: "status", className: "mb-3" }, [
							alertDescription(h, [
								"Databases took too long to load for this time range and are not shown. A shorter range loads them.",
							]),
						]),
					]
				: [],
	})

/** `ResultView` over the bundle: the loading skeleton, the error, or the map. */
const mapArea = (h: H, model: Model, inputs: PageViewInputs): Html =>
	AsyncData.matchData(model.bundle.data, {
		onEmpty: () => serviceMapLoading(h),
		onFailure: (failure) =>
			errorState(h, {
				failure,
				title: "Couldn't load the service map",
				onRetry: Message.ClickedReload(),
			}),
		onData: () => {
			const rows = scopedRows(model, inputs.context.pinnedNamespace)
			if (rows === null || model.window === null || Option.isNone(model.map))
				return serviceMapLoading(h)
			const map = model.map.value
			return mapView(h, map, toMap, {
				viewMode: model.search.view ?? "2d",
				render3D: () => scene3dView(h, { model: model.scene3d, map, toMessage: toScene3d }),
				emptyState: serviceMapEmptyState(h, model),
				detailPanel: detailPanel(
					h,
					model,
					rows,
					durationSecondsOf(model.window),
					map,
					inputs.context.timeZone,
				),
			})
		},
	})

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) =>
	h.div(
		[h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: DB_CHART_TOKENS }))],
		[
			dashboardPage(h, { title: "Service map", actions: headerActions(h, model) }, [
				Option.match(AsyncData.getError(model.facets.data), {
					onSome: (failure) =>
						errorState(h, {
							failure,
							title: "Couldn't load the service map",
							onRetry: Message.ClickedRetryFacets(),
						}),
					onNone: () =>
						h.div(
							[h.Class("contents")],
							[
								...dbEdgesTimedOutNotice(h, model),
								h.div(
									[h.Class("-mx-4 -mb-4 h-[calc(100vh-10rem)]")],
									[mapArea(h, model, inputs)],
								),
							],
						),
				}),
			]),
		],
	),
)
