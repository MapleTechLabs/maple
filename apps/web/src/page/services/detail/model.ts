import { Schema } from "effect"
import { AsyncData } from "foldkit"
import * as Chart from "../../../charts/chart"
import { ChartRuntime } from "../../../charts/chart-runtime"
import { ThemeColors } from "../../../charts/theme-colors"
import { KeyedSchema } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"
import { TimeWindow } from "../../../data/time-range"
import { ServiceSearch } from "../../../route/search"
import * as Select from "../../../ui/select"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { SortState } from "../../kit/table-sort"
import { ENDPOINT_FILTERS } from "./derive-api"
import * as EndpointPeek from "./endpoint-peek/model"
import { ApiBucket, ApiOverview, DependencyBundle, Endpoint, Operation, StatusRow } from "./model-tabs"

// The service detail page.

/** `ServiceDetailTimeSeriesPoint` (@maple/web-data/warehouse/services). */
export const DetailPoint = Schema.Struct({
	bucket: Schema.String,
	throughput: Schema.Number,
	tracedThroughput: Schema.Number,
	hasSampling: Schema.Boolean,
	samplingWeight: Schema.Number,
	errorRate: Schema.Number,
	p50LatencyMs: Schema.Number,
	p95LatencyMs: Schema.Number,
	p99LatencyMs: Schema.Number,
	apdexScore: Schema.Number,
	totalCount: Schema.Number,
	partial: Schema.Boolean,
})
export type DetailPoint = typeof DetailPoint.Type

/** `ReleasePoint` (components/vcs/commit-markers/marker-layout.ts). */
export const Release = Schema.Struct({
	bucket: Schema.String,
	commitSha: Schema.String,
	count: Schema.Number,
	errorCount: Schema.Number,
})
export type Release = typeof Release.Type

/** `ServiceDetailOverviewResult`: the charts, the release timeline and the switcher's options. */
export const OverviewData = Schema.Struct({
	points: Schema.Array(DetailPoint),
	releases: Schema.Array(Release),
	environments: Schema.Array(Schema.String),
})
export type OverviewData = typeof OverviewData.Type

export const RefinementPoint = Schema.Struct({ bucket: Schema.String, throughput: Schema.Number })

/** The `ErrorIssueDocument` fields `IssueLine` reads. */
export const Issue = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	severity: Schema.NullOr(Schema.String),
	occurrenceCount: Schema.Number,
	lastSeenAt: Schema.String,
})
export type Issue = typeof Issue.Type

const UsageTotals = Schema.Struct({
	logs: Schema.Number,
	traces: Schema.Number,
	metrics: Schema.Number,
	dataSize: Schema.Number,
})
export type UsageTotals = typeof UsageTotals.Type
export const Usage = Schema.Struct({ totals: UsageTotals, previous: Schema.NullOr(UsageTotals) })
export type Usage = typeof Usage.Type

/** `ServiceWorkload` (@maple/web-data/warehouse/service-infra). */
export const Workload = Schema.Struct({
	workloadKind: Schema.Literals(["deployment", "statefulset", "daemonset", "unknown"]),
	workloadName: Schema.String,
	namespace: Schema.String,
	clusterName: Schema.String,
	podCount: Schema.Number,
	avgCpuLimitUtilization: Schema.NullOr(Schema.Number),
	avgMemoryLimitUtilization: Schema.NullOr(Schema.Number),
})
export type Workload = typeof Workload.Type

/** The `VcsCommitDetailResponse` fields the deploy rows and marker labels read. */
export const Commit = Schema.Struct({
	sha: Schema.String,
	message: Schema.String,
	authorName: Schema.NullOr(Schema.String),
	authorLogin: Schema.NullOr(Schema.String),
	authorAvatarUrl: Schema.NullOr(Schema.String),
	committedAt: Schema.Number,
})
export type Commit = typeof Commit.Type

/** A failed commit lookup keeps its error tag: "not connected" gets one panel-level CTA. */
export const CommitFailure = Schema.Struct({ tag: Schema.String })
export type CommitFailure = typeof CommitFailure.Type
export const CommitData = AsyncData.Schema(Commit, CommitFailure)
export type CommitData = AsyncData.AsyncData<Commit, CommitFailure>

export const Model = Schema.Struct({
	serviceName: Schema.String,
	search: ServiceSearch,
	/** The clock the window was last resolved at; `null` until the entry Command answered. */
	nowMs: Schema.NullOr(Schema.Number),
	window: Schema.NullOr(TimeWindow),
	overview: KeyedSchema(OverviewData, LoadFailure),
	refinement: KeyedSchema(Schema.Array(RefinementPoint), LoadFailure),
	operations: KeyedSchema(Schema.Array(Operation), LoadFailure),
	endpoints: KeyedSchema(Schema.Array(Endpoint), LoadFailure),
	/** The API tab's collapsed groups ("unrouted", "probes") the user opened. */
	expandedEndpointGroups: Schema.Array(Schema.String),
	/** The API tab's KPI strip and responses chart. */
	apiOverview: KeyedSchema(ApiOverview, LoadFailure),
	/** Per-endpoint buckets of the listed endpoints: the row sparklines and the drawer charts. */
	endpointSeries: KeyedSchema(Schema.Array(ApiBucket), LoadFailure),
	/** Every (endpoint, status code, error.type) of the window: the non-2xx panel and the drawer. */
	statusBreakdown: KeyedSchema(Schema.Array(StatusRow), LoadFailure),
	endpointFilter: Schema.Literals(ENDPOINT_FILTERS),
	endpointQuery: Schema.String,
	endpointPeek: EndpointPeek.Model,
	issues: KeyedSchema(Schema.Array(Issue), LoadFailure),
	usage: KeyedSchema(Usage, LoadFailure),
	workloads: KeyedSchema(Schema.Array(Workload), LoadFailure),
	dependencies: KeyedSchema(DependencyBundle, LoadFailure),
	/** `commitQueryAtom(sha)`, shared by the deploy rows and the marker labels. */
	commits: Schema.Record(Schema.String, CommitData.schema),
	/** `ServiceRecentDeploys`' "Show all" toggle. */
	isDeploysExpanded: Schema.Boolean,
	/** Each tab table's `useTableSort` state. */
	sorts: Schema.Struct({ operations: SortState, endpoints: SortState, dependencies: SortState }),
	environmentSelect: Select.Model,
	timePicker: TimeRangePicker.Model,
	/** One chart Submodel per card and per operation sparkline, by id. */
	charts: Schema.Record(Schema.String, Chart.Model),
	chartRuntime: ChartRuntime,
	themeColors: Schema.NullOr(ThemeColors),
	/** `PageRefreshProvider`: Reloads so far (non-zero stops snapping) and the 600 ms spinner. */
	refreshVersion: Schema.Number,
	isReloading: Schema.Boolean,
})
export type Model = typeof Model.Type
