/**
 * The typed payload each MCP tool hands the chat UI, derived from the tools' output schemas in
 * `./mcp-outputs`. Never hand-write a shape here: the schema is the contract, and the registry
 * encodes every result through it.
 */
import type * as Outputs from "./mcp-outputs"
import type { McpToolOutputs } from "./mcp-outputs"

/** One tool's payload, discriminated by the tool that produced it. */
export type StructuredToolOutput = {
	readonly [Tool in keyof typeof McpToolOutputs]: {
		readonly tool: Tool
		readonly data: (typeof McpToolOutputs)[Tool]["Type"]
	}
}[keyof typeof McpToolOutputs]

/** The payload of one tool. */
export type StructuredToolData<Tool extends StructuredToolOutput["tool"]> = Extract<
	StructuredToolOutput,
	{ readonly tool: Tool }
>["data"]

export type AlertCheckRow = typeof Outputs.AlertCheckRow.Type
export type AlertDestinationRow = typeof Outputs.AlertDestinationRow.Type
export type AlertIncidentRow = typeof Outputs.AlertIncidentRow.Type
export type AlertRuleDetailRow = typeof Outputs.AlertRuleDetailRow.Type
export type AlertRuleRow = typeof Outputs.AlertRuleRow.Type
export type AuditSetupData = typeof Outputs.AuditSetupOutput.Type
export type DashboardRow = typeof Outputs.DashboardRow.Type
export type ErrorDetailSpanSummary = typeof Outputs.ErrorDetailSpanSummary.Type
export type ErrorDetailTrace = typeof Outputs.ErrorDetailTrace.Type
export type ErrorIncidentRow = typeof Outputs.ErrorIncidentRow.Type
export type ErrorIssueCompactRow = typeof Outputs.ErrorIssueCompactRow.Type
export type ErrorIssueRow = typeof Outputs.ErrorIssueRow.Type
export type ErrorTypeRow = typeof Outputs.ErrorTypeRow.Type
export type GetInstrumentationRecommendationsData =
	typeof Outputs.GetInstrumentationRecommendationsOutput.Type
export type IncidentTimelineRow = typeof Outputs.IncidentTimelineRow.Type
export type InspectChartDataData = typeof Outputs.InspectChartDataOutput.Type
export type InspectChartFlag = typeof Outputs.InspectChartFlag.Type
export type InspectChartQueryResult = typeof Outputs.InspectChartQueryResult.Type
export type InspectChartSeriesStat = typeof Outputs.InspectChartSeriesStat.Type
export type InspectChartVerdict = typeof Outputs.InspectChartVerdict.Type
export type InstrumentationCoverageGap = typeof Outputs.InstrumentationCoverageGap.Type
export type InstrumentationRecommendationRow = typeof Outputs.InstrumentationRecommendationRow.Type
export type LogRow = typeof Outputs.LogEntryRow.Type
export type MetricRow = typeof Outputs.ListMetricsMetricRow.Type
export type QueryDataUnit = typeof Outputs.QueryDataUnitSchema.Type
export type ServiceMapEdge = typeof Outputs.ServiceMapEdgeRow.Type
export type SetupAuditCheckRow = typeof Outputs.SetupAuditCheckRow.Type
export type TraceRow = typeof Outputs.TraceSummaryRow.Type
export type WidgetInspectionEntry = typeof Outputs.WidgetInspectionEntry.Type
export type WidgetInspectionSummary = typeof Outputs.WidgetInspectionSummary.Type
export type WidgetInspectionVerdict = typeof Outputs.WidgetInspectionVerdict.Type
export type InspectChartQueryStats = InspectChartQueryResult["stats"]
