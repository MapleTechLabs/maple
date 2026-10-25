import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "../../../../charts/chart"
import { ChartRuntime } from "../../../../charts/chart-runtime"
import { ThemeColors } from "../../../../charts/theme-colors"
import { KeyedSchema } from "../../../../data/keyed"
import { LoadFailure } from "../../../../data/load-failure"
import { TimeWindow } from "../../../../data/time-range"
import { InfraGcpSearch } from "../../../../route/search"
import * as Menu from "../../../../ui/menu"
import * as Select from "../../../../ui/select"
import * as TimeRangePicker from "../../../kit/time-range-picker"
import { FleetRead, GcpStatus, Resources, SparkRead } from "../data"

// `/infra/gcp`.

export const Model = Schema.Struct({
	search: InfraGcpSearch,
	window: Schema.NullOr(TimeWindow),
	nowMs: Schema.Number,
	/** `toLocaleString`'s locale for the instance and connection counts. */
	locale: Schema.String,
	status: KeyedSchema(GcpStatus, LoadFailure),
	fleet: KeyedSchema(Schema.Array(FleetRead), LoadFailure),
	sparks: KeyedSchema(Schema.Array(SparkRead), LoadFailure),
	/** The Cloud SQL inventory, read while that view shows. */
	cloudSqlInventory: KeyedSchema(Resources, LoadFailure),
	/** The Resources view's inventory, filtered by type and project. */
	resources: KeyedSchema(Resources, LoadFailure),
	resourceTypeSelect: Select.Model,
	resourceProjectSelect: Select.Model,
	projectMenu: Menu.Model,
	chartRuntime: ChartRuntime,
	themeColors: Schema.NullOr(ThemeColors),
	timePicker: TimeRangePicker.Model,
	refreshVersion: Schema.Number,
	isReloading: Schema.Boolean,
})
export type Model = typeof Model.Type

export const RequestMode = Schema.Literals(["Load", "Refresh"])
export type RequestMode = typeof RequestMode.Type

const result = <A extends Schema.Top>(schema: A) => ({
	key: Schema.String,
	result: Schema.Result(schema, LoadFailure),
})

export const Message = defineMessageUnion({
	CompletedResolveWindow: {
		window: TimeWindow,
		nowMs: Schema.Number,
		locale: Schema.String,
		mode: RequestMode,
	},
	CompletedLoadStatus: result(GcpStatus),
	CompletedFetchFleet: result(Schema.Array(FleetRead)),
	CompletedFetchSparks: result(Schema.Array(SparkRead)),
	CompletedFetchCloudSqlInventory: result(Resources),
	CompletedFetchResources: result(Resources),
	CompletedLoadChartRuntime: {},
	FailedLoadChartRuntime: { reason: Schema.String },
	ResolvedThemeColors: { colors: ThemeColors },
	/** `useIntervalRefresh`: the status while connected, the fleet while waiting, resources while empty. */
	TickedStatusRefresh: {},
	TickedFleetRefresh: {},
	TickedResourcesRefresh: {},
	/** `useLiveClock`: connector states that expire on a timer (setup, waiting) age while open. */
	TickedLiveClock: { nowMs: Schema.Number },
	ClickedRetryStatus: {},
	ClickedRetryFleet: {},
	ClickedRetryResources: {},
	ClickedView: { view: Schema.String },
	ClickedScope: { scope: Schema.optional(Schema.String) },
	ChangedSearch: { value: Schema.String },
	ClickedClearSearch: {},
	ClickedClearRegion: {},
	SelectedProject: { project: Schema.optional(Schema.String) },
	ClickedReload: {},
	ClickedResetTimeRange: {},
	CompletedReloadSpin: { version: Schema.Number },
	GotTimePickerMessage: { message: TimeRangePicker.Message },
	GotSparklineMessage: { message: Chart.Message },
	GotResourceTypeSelectMessage: { message: Select.Message },
	GotResourceProjectSelectMessage: { message: Select.Message },
	GotProjectMenuMessage: { message: Menu.Message },
})
export type Message = typeof Message.Type
