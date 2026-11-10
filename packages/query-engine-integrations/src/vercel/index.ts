// Vercel integration queries: the /infra/vercel project table, per-project charts,
// functions, the event drains and AI Gateway usage.

export {
	vercelProjectLatencySQL,
	vercelProjectRequestsSQL,
	vercelProjectTopErrorsSQL,
	vercelProjectTopPathsSQL,
	vercelRequestTimeseriesSQL,
	type VercelProjectScope,
} from "./vercel-infra"
export { vercelFunctionRoutesSQL, vercelProjectDependenciesSQL, vercelProjectFunctionsSQL } from "./vercel-functions"
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
