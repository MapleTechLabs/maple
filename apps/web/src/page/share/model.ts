import { TimeRangeSchema } from "@maple/domain/http"
import { DashboardSectionSchema, WidgetDisplayConfigV3, WidgetLayoutSchema } from "@maple/widgets/dashboard"
import { Schema } from "effect"
import * as Chart from "../../charts/chart"
import { ChartRuntime } from "../../charts/chart-runtime"
import { ThemeColors } from "../../charts/theme-colors"
import { ShareSearch } from "../../route/search"
import * as Menu from "../../ui/menu"
import { TableSort } from "../dashboards/kit/tiles"

// `/share/$token`.

/** `ShareWidgetSchema`: a redacted widget, no stored query. */
export const ShareWidget = Schema.Struct({
	id: Schema.String,
	visualization: Schema.String,
	display: WidgetDisplayConfigV3,
	layout: WidgetLayoutSchema,
	sectionId: Schema.optionalKey(Schema.String),
	tabId: Schema.optionalKey(Schema.String),
	timeRange: Schema.optionalKey(TimeRangeSchema),
	dataSource: Schema.Struct({
		kind: Schema.String,
		resultShape: Schema.optionalKey(Schema.String),
		transform: Schema.optionalKey(Schema.Unknown),
	}),
})
export type ShareWidget = typeof ShareWidget.Type

export const SharedDashboard = Schema.Struct({
	mode: Schema.Literals(["public", "org"]),
	scope: Schema.Literals(["dashboard", "widget"]),
	embeddable: Schema.Boolean,
	dashboard: Schema.Struct({
		id: Schema.String,
		name: Schema.String,
		timeRange: Schema.Unknown,
		widgets: Schema.Array(ShareWidget),
		/** Decoded on their own (`decodeShare`): a shape this build can't read costs the grouping only. */
		sections: Schema.Array(DashboardSectionSchema),
		refreshIntervalSeconds: Schema.optionalKey(Schema.Number),
	}),
})
export type SharedDashboard = typeof SharedDashboard.Type

/** `ShareResolveError`. */
export const ShareError = Schema.Union([
	Schema.TaggedStruct("NotFound", {}),
	Schema.TaggedStruct("SignInRequired", {}),
	Schema.TaggedStruct("WrongOrg", {}),
	Schema.TaggedStruct("RateLimited", {}),
	Schema.TaggedStruct("Unavailable", { message: Schema.String }),
])
export type ShareError = typeof ShareError.Type

export const Resolve = Schema.Union([
	Schema.TaggedStruct("Loading", {}),
	Schema.TaggedStruct("Ready", { share: SharedDashboard }),
	Schema.TaggedStruct("Failed", { error: ShareError }),
])
export type Resolve = typeof Resolve.Type

/** `ReadyData`: rows, or one value. */
const ReadyDataSchema = Schema.Union([
	Schema.TaggedStruct("Rows", { rows: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)) }),
	Schema.TaggedStruct("Value", { value: Schema.Unknown }),
])

/** One widget's data as `useShareWidgetData` holds it. */
export const WidgetState = Schema.Union([
	Schema.TaggedStruct("Loading", {}),
	Schema.TaggedStruct("Ready", { data: ReadyDataSchema }),
	Schema.TaggedStruct("Error", {
		message: Schema.String,
		kind: Schema.NullOr(Schema.Literals(["range", "runtime"])),
	}),
])
export type WidgetState = typeof WidgetState.Type

export const QueuedBatch = Schema.Struct({
	startTime: Schema.String,
	endTime: Schema.String,
	variableValues: Schema.Record(Schema.String, Schema.String),
	requests: Schema.Array(
		Schema.Struct({
			widgetId: Schema.String,
			key: Schema.String,
			maxDataPoints: Schema.optional(Schema.Number),
			transform: Schema.optional(Schema.Unknown),
		}),
	),
})
export type QueuedBatch = typeof QueuedBatch.Type

export const ShareWindow = Schema.Struct({
	startTime: Schema.String,
	endTime: Schema.String,
	label: Schema.String,
})
export type ShareWindow = typeof ShareWindow.Type

export const Model = Schema.Struct({
	token: Schema.String,
	search: ShareSearch,
	resolve: Resolve,
	/** `refreshTick`: Reloads and auto-refresh ticks so far (non-zero stops snapping). */
	refreshTick: Schema.Number,
	window: Schema.NullOr(ShareWindow),
	/** Each mounted tile's measured `maxDataPoints`. */
	options: Schema.Record(Schema.String, Schema.Number),
	/** The request key each widget was last fetched under (`requested`). */
	requested: Schema.Record(Schema.String, Schema.String),
	isFlushScheduled: Schema.Boolean,
	/** Batches after the one in flight; each is awaited before the next is sent. */
	queuedBatches: Schema.Array(QueuedBatch),
	/** The id of the batch sent last; an older batch's answer settles its tiles but sends nothing. */
	sentBatchId: Schema.Number,
	states: Schema.Record(Schema.String, WidgetState),
	gridWidth: Schema.Number,
	charts: Schema.Record(Schema.String, Chart.Model),
	tableSorts: Schema.Record(Schema.String, TableSort),
	themeColors: Schema.NullOr(ThemeColors),
	chartRuntime: ChartRuntime,
	refreshMenu: Menu.Model,
	nowMs: Schema.Number,
	/** `isFramed()`: inside an iframe (a cross-origin parent counts), read once on entry. */
	isFramed: Schema.Boolean,
	/** The variables the last answered batch resolved (`useShareWidgetData`'s `variables`). */
	variables: Schema.Record(Schema.String, Schema.String),
	/** `ReadOnlyDashboardView`'s local section state: collapse overrides and active tabs. */
	sectionView: Schema.Struct({
		collapsed: Schema.optionalKey(Schema.String),
		expanded: Schema.optionalKey(Schema.String),
		tab: Schema.optionalKey(Schema.String),
	}),
})
export type Model = typeof Model.Type
