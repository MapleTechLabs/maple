import { ChartEnvMessages } from "@maple/views/charts/chart-env"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "@maple/views/charts/chart"
import { FixedMetricRow } from "@maple/views/charts/chart-spec"
import { LoadFailure } from "@maple/views/data/load-failure"
import * as Select from "@maple/views/ui/select"
import { SignalPresences } from "@maple/views/data/signal-presence"
import * as TimeRangePicker from "../kit/time-range-picker"
import * as SetupChecklist from "./setup-checklist"
import { HealthMessages } from "../kit/service-health"
import { FacetsHint, HealthSnapshot, OverviewFacets, OverviewPoint, RefinementPoint, Usage } from "./model"

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
	CompletedFetchUsage: result(Usage),
	CompletedFetchOverviewSeries: result(Schema.Array(OverviewPoint)),
	CompletedFetchLogSeries: result(Schema.Array(FixedMetricRow)),
	CompletedFetchRefinement: result(Schema.Array(RefinementPoint)),
	CompletedSaveFacetsHint: {},
	...HealthMessages,
	FailedLoadRules: { orgId: Schema.String },
	UpdatedRules: { orgId: Schema.String, enabled: Schema.Array(Schema.Boolean) },
	UpdatedRuleStates: { orgId: Schema.String },
	CompletedLoadSignalPresence: { result: Schema.Result(SignalPresences, LoadFailure) },
	...ChartEnvMessages,
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
