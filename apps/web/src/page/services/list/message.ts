import { V2AnomalyServiceCount } from "@maple/domain/http/v2"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "../../../charts/chart"
import { ThemeColors } from "../../../charts/theme-colors"
import { LoadFailure } from "../../../data/load-failure"
import { TimeWindow } from "../../../data/time-range"
import * as FilterSections from "../../../ui/filters/filter-sections"
import * as HoverCard from "../../../ui/hover-card"
import * as Tooltip from "../../../ui/tooltip"
import { CommitDetail, CommitFailure } from "../../kit/commit-card"
import { SignalPresences } from "../../kit/signal-presence"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { IncidentCause, LatencyBaseline, ServiceRow, ServicesFacets, Sparklines } from "./model"

/** `Load` on entry or a search change; `Refresh` from Reload (no cache snap, revalidate every slot). */
export const RequestMode = Schema.Literals(["Load", "Refresh"])
export type RequestMode = typeof RequestMode.Type

/** The URL's facet filters, by their include param. */
export const Facet = Schema.Literals(["environments", "namespaces", "commitShas"])
export type Facet = typeof Facet.Type

export const FilterParam = Schema.Literals([
	"environments",
	"namespaces",
	"commitShas",
	"excludedEnvironments",
	"excludedNamespaces",
	"excludedCommitShas",
])

export const RowTooltip = Schema.Literals(["rollout", "sampling", "unnamed"])
export type RowTooltip = typeof RowTooltip.Type

export const GroupBy = Schema.Literals(["namespace", "environment"])
export type GroupBy = typeof GroupBy.Type

const result = <A extends Schema.Top>(schema: A) => ({
	key: Schema.String,
	result: Schema.Result(schema, LoadFailure),
})

export const Message = defineMessageUnion({
	CompletedResolveWindow: { window: TimeWindow, nowMs: Schema.Number, mode: RequestMode },
	CompletedFetchOverview: result(Schema.Array(ServiceRow)),
	CompletedFetchSparklines: result(Sparklines),
	CompletedFetchFacets: result(ServicesFacets),
	CompletedFetchBaseline: result(Schema.Array(LatencyBaseline)),
	CompletedFetchAnomalies: result(Schema.Array(V2AnomalyServiceCount)),
	CompletedFetchCommitMessages: result(Schema.Record(Schema.String, Schema.String)),
	PaintedTable: {},
	CompletedLoadSignalPresence: { result: Schema.Result(SignalPresences, LoadFailure) },
	UpdatedIncidents: { orgId: Schema.String, incidents: Schema.Array(IncidentCause) },
	FailedLoadIncidents: { orgId: Schema.String },
	CompletedLoadChartRuntime: {},
	FailedLoadChartRuntime: { reason: Schema.String },
	ResolvedThemeColors: { colors: ThemeColors },
	ClickedReload: {},
	CompletedReloadSpin: { version: Schema.Number },
	ClickedRetryFacets: {},
	ToggledFacetOption: { facet: Facet, name: Schema.String },
	ClickedOnlyFacetOption: { facet: Facet, name: Schema.String },
	ClickedExcludeFacetOption: { facet: Facet, name: Schema.String },
	ToggledHealthOption: { name: Schema.String },
	ClickedClearAllFilters: {},
	ClickedClearServiceFilters: {},
	ClickedGroupBy: { groupBy: GroupBy },
	ClickedResetTimeRange: {},
	ClickedClearNamespacePin: {},
	RemovedFilterChip: { param: FilterParam },
	ClickedServiceRow: { serviceName: Schema.String, environment: Schema.String },
	ClickedServiceLink: { url: Schema.String },
	GotFilterSectionsMessage: { message: FilterSections.Message },
	GotSparklineMessage: { message: Chart.Message },
	GotTimePickerMessage: { message: TimeRangePicker.Message },
	GotRowTooltipMessage: { tooltip: RowTooltip, message: Tooltip.Message },
	GotCommitCardMessage: { message: HoverCard.Message },
	ElapsedCommitArm: { sha: Schema.String, generation: Schema.Number },
	CompletedFetchCommitDetail: { sha: Schema.String, result: Schema.Result(CommitDetail, CommitFailure) },
	ClickedCopyCommitSha: { sha: Schema.String, serviceName: Schema.String, environment: Schema.String },
	/** The SHA write landed; the row opens with its toast now that the outcome is known. */
	CompletedCopyCommitSha: { rowUrl: Schema.String, isCopied: Schema.Boolean },
})
export type Message = typeof Message.Type
