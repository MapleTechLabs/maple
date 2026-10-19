// Vercel AI Gateway usage (/infra/vercel, AI Gateway section)
//
// A trace drain carries AI Gateway traces as service `ai-gateway` in namespace
// `vercel`. Each gateway request is one server span carrying the usage, the model
// and the cost (`vercel.ai_gateway.cost.total`, a decimal string). Keying on the
// kind, not on an empty parent, keeps requests whose caller propagated a trace
// context. Child spans (routing, model attempts) are not counted.

import * as CH from "@maple-dev/effect-orm/expr"
import { from, param, type ColumnAccessor } from "@maple-dev/effect-orm/clickhouse"
import { Traces, orgIdParam } from "@maple/query-engine/ch/tables"
import { isoBucket } from "@maple/query-engine/ch/format"
import type { VercelProjectScope } from "./vercel-infra"

export const VERCEL_AI_GATEWAY_SERVICE = "ai-gateway"

type TraceColumns = ColumnAccessor<typeof Traces.columns>

const numberAttribute = ($: TraceColumns, key: string) => CH.toFloat64OrZero($.SpanAttributes.get(key))

const usageColumns = ($: TraceColumns) => ({
	requests: CH.count(),
	/** USD only (an absent currency is USD), so the "$" in the UI holds. */
	costUsd: CH.sumIf(
		numberAttribute($, "vercel.ai_gateway.cost.total"),
		CH.inList($.SpanAttributes.get("vercel.ai_gateway.cost.currency"), ["", "USD"]),
	),
	inputTokens: CH.sum(numberAttribute($, "gen_ai.usage.input_tokens")),
	outputTokens: CH.sum(numberAttribute($, "gen_ai.usage.output_tokens")),
	errors: CH.countIf($.StatusCode.eq("Error")),
})

const gatewayWhere = ($: TraceColumns, scope: VercelProjectScope) => [
	$.OrgId.eq(orgIdParam),
	$.ServiceName.eq(VERCEL_AI_GATEWAY_SERVICE),
	$.Timestamp.gte(param.dateTime("startTime")),
	$.Timestamp.lte(param.dateTime("endTime")),
	$.SpanKind.eq("Server"),
	$.ResourceAttributes.get("service.namespace").eq("vercel"),
	CH.when(scope.projectId, (id) => $.SpanAttributes.get("vercel.project.id").eq(id)),
]

/** Totals over the window, for every project or one. */
export function vercelAiGatewaySummarySQL(scope: VercelProjectScope = {}) {
	return from(Traces)
		.select(($) => ({
			...usageColumns($),
			p50DurationMs: CH.quantile(0.5)($.Duration).div(1_000_000),
			p95DurationMs: CH.quantile(0.95)($.Duration).div(1_000_000),
		}))
		.where(($) => gatewayWhere($, scope))
		.format("JSON")
}

/** Usage per model, most expensive first. */
export function vercelAiGatewayByModelSQL(scope: VercelProjectScope = {}) {
	return from(Traces)
		.select(($) => ({
			model: CH.if_(
				$.SpanAttributes.get("gen_ai.response.model").neq(""),
				$.SpanAttributes.get("gen_ai.response.model"),
				$.SpanAttributes.get("gen_ai.request.model"),
			),
			provider: CH.any_($.SpanAttributes.get("vercel.ai_gateway.provider")),
			...usageColumns($),
			p95DurationMs: CH.quantile(0.95)($.Duration).div(1_000_000),
		}))
		.where(($) => gatewayWhere($, scope))
		.groupBy("model")
		.orderBy(["costUsd", "desc"], ["requests", "desc"])
		.limit(50)
		.format("JSON")
}

/** Usage per calling Vercel project. Requests made outside a project have an empty id. */
export function vercelAiGatewayByProjectSQL() {
	return from(Traces)
		.select(($) => ({
			projectId: $.SpanAttributes.get("vercel.project.id"),
			...usageColumns($),
		}))
		.where(($) => gatewayWhere($, {}))
		.groupBy("projectId")
		.orderBy(["costUsd", "desc"], ["requests", "desc"])
		.limit(200)
		.format("JSON")
}

/** Cost, requests and tokens per bucket, for every project or one. */
export function vercelAiGatewayTimeseriesSQL(scope: VercelProjectScope = {}) {
	return from(Traces)
		.select(($) => ({
			bucket: isoBucket($.Timestamp),
			...usageColumns($),
		}))
		.where(($) => gatewayWhere($, scope))
		.groupBy("bucket")
		.orderBy(["bucket", "asc"])
		.limit(2000)
		.format("JSON")
}
