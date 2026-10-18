import { DB_NODE_PREFIX, parseDbNodeId } from "@maple/ui/components/service-map/service-map-utils"
import { Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { serviceMapLoading } from "../../service-map/map/loading"
import * as ServiceMap from "../../service-map/map/service-map"
import { view as mapView } from "../../service-map/map/view"
import { errorState } from "../../ui/error-state"
import { segmentedSelect } from "../../ui/segmented-select"
import type * as Select from "../../ui/select"
import * as SelectView from "../../ui/select-view"
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
import { databasePanel } from "./view-db-panel"
import { serviceMapEmptyState } from "./view-empty"
import { servicePanel } from "./view-service-panel"

// `ServiceMapPage` / `ServiceMapContent` (apps/web/src/routes/service-map.tsx).

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
			entries: environmentItems(model).map((item): SelectView.SelectEntry => ({ _tag: "Item", item })),
			size: "sm",
			className: "w-full min-w-0 @2xl/page:w-auto @2xl/page:min-w-36",
			toView: (parts) =>
				h.div([h.Class("flex flex-wrap items-center gap-2")], [views, ...parts, controls]),
		},
	})
}

const toMap = (message: ServiceMap.Message) => Message.GotMapMessage({ message })

/** `renderDetailPanel`: a database node gets its panel, anything else the service panel. */
const detailPanel =
	(h: H, model: Model, rows: ScopedRows, durationSeconds: number, map: ServiceMap.Model) =>
	(selectedId: string): Html => {
		if (!selectedId.startsWith(DB_NODE_PREFIX))
			return servicePanel(h, model, {
				serviceId: selectedId,
				rows,
				durationSeconds,
				colorMode: map.colorMode,
			})
		const node = map.source.rawNodes.find((candidate) => candidate.id === selectedId)
		return databasePanel(h, model, {
			nodeId: selectedId,
			...parseDbNodeId(selectedId),
			planetscale: node?.data.planetscale,
			rows,
			durationSeconds,
		})
	}

/**
 * TODO(3d): the React Three Fiber scene (`components/service-map/three`) is not ported: the route
 * opens in 2D, and the 3D view needs its own vanilla three Mount (decision s5).
 */
const scene3d = (h: H): Html =>
	h.div(
		[h.Class("flex h-full items-center justify-center text-sm text-muted-foreground")],
		["The 3D view is not available yet."],
	)

/** `ResultView` over the bundle: the loading skeleton, the error, or the map. */
const mapArea = (h: H, model: Model, inputs: PageViewInputs): Html =>
	AsyncData.matchData(model.bundle.data, {
		onEmpty: () => serviceMapLoading(h),
		onFailure: (failure) => errorState(h, { failure }),
		onData: () => {
			const rows = scopedRows(model, inputs.context.pinnedNamespace)
			if (rows === null || model.window === null || Option.isNone(model.map))
				return serviceMapLoading(h)
			const map = model.map.value
			return mapView(h, map, toMap, {
				viewMode: model.search.view ?? "2d",
				render3D: () => scene3d(h),
				emptyState: serviceMapEmptyState(h, model),
				detailPanel: detailPanel(h, model, rows, durationSecondsOf(model.window), map),
			})
		},
	})

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) =>
	dashboardPage(h, { actions: headerActions(h, model) }, [
		Option.match(AsyncData.getError(model.facets.data), {
			onSome: (failure) =>
				errorState(h, {
					failure,
					title: "Failed to load service environments",
					onRetry: Message.ClickedRetryFacets(),
				}),
			onNone: () => h.div([h.Class("-mx-4 -mb-4 h-[calc(100vh-10rem)]")], [mapArea(h, model, inputs)]),
		}),
	]),
)
