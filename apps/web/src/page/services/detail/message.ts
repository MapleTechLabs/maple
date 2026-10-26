import { V2UptimeMonitor } from "@maple/domain/http/v2"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "../../../charts/chart"
import { ThemeColors } from "../../../charts/theme-colors"
import { LoadFailure } from "../../../data/load-failure"
import * as Select from "../../../ui/select"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { ServiceTab } from "./derive"
import { ENDPOINT_FILTERS } from "./derive-api"
import * as EndpointPeek from "./endpoint-peek/message"
import {
	ApiBucket,
	ApiOverview,
	DependencyBundle,
	Endpoint,
	Operation,
	SortTable,
	StatusRow,
} from "./model-tabs"
import { Commit, CommitFailure, Issue, OverviewData, RefinementPoint, Usage, Workload } from "./model"

/** `Load` on entry or a search change; `Refresh` from Reload (no cache snap, revalidate every slot). */
export const RequestMode = Schema.Literals(["Load", "Refresh"])
export type RequestMode = typeof RequestMode.Type

/** The reads that can be retried from their error state. */
export const RetryTarget = Schema.Literals(["Overview"])
export type RetryTarget = typeof RetryTarget.Type

const result = <A extends Schema.Top>(schema: A) => ({
	key: Schema.String,
	result: Schema.Result(schema, LoadFailure),
})

export const Message = defineMessageUnion({
	CompletedResolveClock: { nowMs: Schema.Number, mode: RequestMode },
	CompletedFetchOverview: result(OverviewData),
	CompletedFetchRefinement: result(Schema.Array(RefinementPoint)),
	CompletedFetchOperations: result(Schema.Array(Operation)),
	CompletedFetchEndpoints: result(Schema.Array(Endpoint)),
	CompletedFetchApiOverview: result(ApiOverview),
	CompletedFetchEndpointSeries: result(Schema.Array(ApiBucket)),
	CompletedFetchStatusBreakdown: result(Schema.Array(StatusRow)),
	CompletedFetchIssues: result(Schema.Array(Issue)),
	CompletedFetchUsage: result(Usage),
	CompletedFetchUptimeMonitors: result(Schema.Array(V2UptimeMonitor)),
	CompletedFetchWorkloads: result(Schema.Array(Workload)),
	CompletedFetchDependencies: result(DependencyBundle),
	CompletedFetchCommit: { sha: Schema.String, result: Schema.Result(Commit, CommitFailure) },
	CompletedMountLinkedCursor: {},
	CompletedLoadChartRuntime: {},
	FailedLoadChartRuntime: { reason: Schema.String },
	ResolvedThemeColors: { colors: ThemeColors },
	ClickedReload: {},
	CompletedReloadSpin: { version: Schema.Number },
	ClickedRetry: { target: RetryTarget },
	ClickedResetTimeRange: {},
	ClickedTab: { tab: ServiceTab },
	ClickedToggleDeploys: {},
	ClickedSort: { table: SortTable, key: Schema.String },
	/** An Operations or API row: the span name's spans in /traces. */
	ClickedOperation: { spanName: Schema.String },
	/** A Dependencies row: the service's spans to that target in /traces. */
	ClickedDependency: { whereClause: Schema.String },
	/** "Show anyway" / "Hide" on a collapsed API group. */
	ClickedToggleEndpointGroup: { kind: Schema.String },
	/** An API row: its drawer (`?endpoint=`). */
	ClickedEndpoint: { spanName: Schema.String },
	ClickedEndpointFilter: { filter: Schema.Literals(ENDPOINT_FILTERS) },
	ChangedEndpointQuery: { value: Schema.String },
	GotEndpointPeekMessage: { message: EndpointPeek.Message },
	GotEnvironmentSelectMessage: { message: Select.Message },
	GotTimePickerMessage: { message: TimeRangePicker.Message },
	GotChartMessage: { chartId: Schema.String, message: Chart.Message },
})
export type Message = typeof Message.Type
