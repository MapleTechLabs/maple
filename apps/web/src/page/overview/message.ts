import { V2AnomalyServiceCount } from "@maple/domain/http/v2"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "../../charts/chart"
import { FixedMetricRow } from "../../charts/chart-spec"
import { ThemeColors } from "../../charts/theme-colors"
import { LoadFailure } from "../../data/load-failure"
import * as Select from "../../ui/select"
import { SignalPresences } from "../kit/signal-presence"
import * as TimeRangePicker from "../kit/time-range-picker"
import * as SetupChecklist from "./setup-checklist"
import {
	FacetsHint,
	HealthSnapshot,
	Incident,
	OverviewFacets,
	OverviewPoint,
	RefinementPoint,
	Usage,
} from "./model"

/** `Load` on entry or a search change; `Refresh` from Reload (no cache snap, revalidate every slot). */
export const RequestMode = Schema.Literals(["Load", "Refresh"])
export type RequestMode = typeof RequestMode.Type

/** The cards whose query can be retried from their error state. */
export const RetryTarget = Schema.Literals(["Facets", "Overview", "LogVolume", "Refinement"])
export type RetryTarget = typeof RetryTarget.Type

const result = <A extends Schema.Top>(schema: A) => ({
	key: Schema.String,
	result: Schema.Result(schema, LoadFailure),
})

export const Message = defineMessageUnion({
	CompletedMountLinkedCursor: {},
	CompletedReadEntry: { nowMs: Schema.Number, hint: FacetsHint },
	CompletedResolveClock: { nowMs: Schema.Number },
	CompletedFetchFacets: result(OverviewFacets),
	CompletedFetchSnapshot: result(Schema.Array(HealthSnapshot)),
	CompletedFetchAnomalies: result(Schema.Array(V2AnomalyServiceCount)),
	CompletedFetchUsage: result(Usage),
	CompletedFetchOverviewSeries: result(Schema.Array(OverviewPoint)),
	CompletedFetchLogSeries: result(Schema.Array(FixedMetricRow)),
	CompletedFetchRefinement: result(Schema.Array(RefinementPoint)),
	CompletedSaveFacetsHint: {},
	UpdatedIncidents: { orgId: Schema.String, incidents: Schema.Array(Incident) },
	FailedLoadIncidents: { orgId: Schema.String },
	FailedLoadRules: { orgId: Schema.String },
	UpdatedRules: { orgId: Schema.String, enabled: Schema.Array(Schema.Boolean) },
	UpdatedRuleStates: { orgId: Schema.String },
	CompletedLoadSignalPresence: { result: Schema.Result(SignalPresences, LoadFailure) },
	CompletedLoadChartRuntime: {},
	FailedLoadChartRuntime: { reason: Schema.String },
	ResolvedThemeColors: { colors: ThemeColors },
	ClickedReload: {},
	CompletedReloadSpin: { version: Schema.Number },
	ClickedRetry: { target: RetryTarget },
	/** The page strip's Try again: every failed read on the page, not just one card's. */
	ClickedRetryPage: {},
	ClickedResetTimeRange: {},
	GotEnvironmentSelectMessage: { message: Select.Message },
	GotTimePickerMessage: { message: TimeRangePicker.Message },
	GotChartMessage: { chartId: Schema.String, message: Chart.Message },
	GotSetupMessage: { message: SetupChecklist.Message },
})
export type Message = typeof Message.Type
