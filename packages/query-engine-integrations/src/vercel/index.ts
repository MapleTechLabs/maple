// Vercel integration queries: the /infra/vercel project table, per-project charts,
// functions, the event drains and AI Gateway usage.

export {
	vercelProjectLatencySQL,
	vercelProjectRequestsSQL,
	vercelProjectErrorLogsSQL,
	VERCEL_ERROR_LOG_SAMPLE,
	vercelProjectTopPathsSQL,
	vercelRequestTimeseriesSQL,
	vercelProjectBreakdownSQL,
	vercelEdgeLatencyTimeseriesSQL,
	VERCEL_BREAKDOWN_ATTRIBUTES,
	type VercelBreakdownDimension,
	type VercelBreakdownStatus,
	type VercelProjectScope,
} from "./vercel-infra"
export {
	clusterVercelErrorLogs,
	errorPatternSearch,
	type VercelErrorLogRow,
	type VercelErrorPattern,
} from "./vercel-errors"
export {
	vercelFunctionRoutesSQL,
	vercelFunctionTimeseriesSQL,
	vercelProjectDependenciesSQL,
	vercelProjectFunctionsSQL,
} from "./vercel-functions"
export {
	vercelAuditLogSQL,
	vercelSpeedInsightsSQL,
	vercelWebAnalyticsSummarySQL,
	vercelWebAnalyticsTopSQL,
	type VercelSpeedInsightsGroup,
	type VercelWebAnalyticsDimension,
} from "./vercel-event-drains"
export {
	VERCEL_AI_GATEWAY_SERVICE,
	vercelAiGatewayByModelSQL,
	vercelAiGatewayByProjectSQL,
	vercelAiGatewaySummarySQL,
	vercelAiGatewayTimeseriesSQL,
} from "./vercel-ai-gateway"
