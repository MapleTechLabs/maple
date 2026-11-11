import { ChartEnvMessages, ChartEnvFields } from "@maple/views/charts/chart-env"
import { RequestMode } from "@maple/views/data/keyed"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "@maple/views/charts/chart"
import { KeyedSchema } from "@maple/views/data/keyed"
import { LoadFailure } from "@maple/views/data/load-failure"
import { TimeWindow } from "../../../../data/time-range"
import { InfraGcpSearch } from "../../../../route/search"
import * as Menu from "@maple/views/ui/menu"
import * as Select from "@maple/views/ui/select"
import * as TimeRangePicker from "../../../kit/time-range-picker"
import { FleetRead, GcpStatus, Resources, SparkRead } from "../data"

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
	...ChartEnvFields,
	timePicker: TimeRangePicker.Model,
	refreshVersion: Schema.Number,
	isReloading: Schema.Boolean,
})
export type Model = typeof Model.Type

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
	...ChartEnvMessages,
	/** The status while connected, the fleet while waiting, resources while empty. */
	TickedStatusRefresh: {},
	TickedFleetRefresh: {},
	TickedResourcesRefresh: {},
	/** Connector states that expire on a timer (setup, waiting) age while open. */
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
