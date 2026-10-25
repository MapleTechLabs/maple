import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "../../../../charts/chart"
import { ChartRuntime } from "../../../../charts/chart-runtime"
import { ThemeColors } from "../../../../charts/theme-colors"
import { KeyedSchema } from "../../../../data/keyed"
import { LoadFailure } from "../../../../data/load-failure"
import { TimeWindow } from "../../../../data/time-range"
import { InfraGcpResourceSearch } from "../../../../route/search"
import * as CopyButton from "../../../../ui/copy-button"
import * as Dialog from "../../../../ui/dialog"
import * as TimeRangePicker from "../../../kit/time-range-picker"
import {
	BucketPoint,
	FleetRead,
	OverviewRow,
	Resources,
	ServiceId,
	Statement,
	StatementSpan,
	TraceSide,
} from "../data"

// `/infra/gcp/$service/$name`.

export const Model = Schema.Struct({
	service: ServiceId,
	name: Schema.String,
	search: InfraGcpResourceSearch,
	window: Schema.NullOr(TimeWindow),
	nowMs: Schema.Number,
	timeseries: KeyedSchema(Schema.Array(BucketPoint), LoadFailure),
	/** The workload's own inventory resource, by its identity. */
	resource: KeyedSchema(Resources, LoadFailure),
	/** The traced service of the workload's name, for the trace-gap callout and the rail. */
	overview: KeyedSchema(Schema.Array(OverviewRow), LoadFailure),
	/** A GKE container's cluster nodes. */
	nodes: KeyedSchema(Schema.Array(BucketPoint), LoadFailure),
	/** A Cloud SQL instance's reads: the inventory, its statements, the traces' side, the fleet. */
	sqlInventory: KeyedSchema(Resources, LoadFailure),
	topQueries: KeyedSchema(Schema.Array(Statement), LoadFailure),
	traceSide: KeyedSchema(TraceSide, LoadFailure),
	fleet: KeyedSchema(Schema.Array(FleetRead), LoadFailure),
	showAllQueries: Schema.Boolean,
	/** `GcpQueryPeekSheet`, opened by `search.peek`. */
	queryPeek: Dialog.Model,
	/** The peeked statement's slowest spans. */
	statementSpans: KeyedSchema(Schema.Array(StatementSpan), LoadFailure),
	copyStatement: CopyButton.Model,
	charts: Schema.Record(Schema.String, Chart.Model),
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
	CompletedResolveWindow: { window: TimeWindow, nowMs: Schema.Number, mode: RequestMode },
	CompletedFetchTimeseries: result(Schema.Array(BucketPoint)),
	CompletedFetchResource: result(Resources),
	CompletedFetchOverview: result(Schema.Array(OverviewRow)),
	CompletedFetchNodes: result(Schema.Array(BucketPoint)),
	CompletedFetchSqlInventory: result(Resources),
	CompletedFetchTopQueries: result(Schema.Array(Statement)),
	CompletedFetchTraceSide: result(TraceSide),
	CompletedFetchFleet: result(Schema.Array(FleetRead)),
	CompletedFetchStatementSpans: result(Schema.Array(StatementSpan)),
	CompletedLoadChartRuntime: {},
	FailedLoadChartRuntime: { reason: Schema.String },
	ResolvedThemeColors: { colors: ThemeColors },
	AttachedLinkedCursor: {},
	ClickedRetryTimeseries: {},
	ClickedShowAllQueries: {},
	ClickedStatement: { queryHash: Schema.String },
	ClickedRetryStatementSpans: {},
	GotQueryPeekMessage: { message: Dialog.Message },
	GotCopyStatementMessage: { message: CopyButton.Message },
	ClickedReload: {},
	ClickedResetTimeRange: {},
	CompletedReloadSpin: { version: Schema.Number },
	GotTimePickerMessage: { message: TimeRangePicker.Message },
	GotChartMessage: { chartId: Schema.String, message: Chart.Message },
})
export type Message = typeof Message.Type
