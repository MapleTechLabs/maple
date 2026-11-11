import { describe, expect, it } from "vitest"
import { compileUnsafe } from "@maple-dev/effect-orm/clickhouse"
import { OrgId } from "@maple/domain"
import {
	vercelProjectLatencySQL,
	vercelProjectRequestsSQL,
	vercelProjectErrorLogsSQL,
	vercelProjectTopPathsSQL,
	vercelRequestTimeseriesSQL,
} from "./vercel-infra"
import {
	vercelAiGatewayByModelSQL,
	vercelAiGatewayByProjectSQL,
	vercelAiGatewaySummarySQL,
	vercelAiGatewayTimeseriesSQL,
} from "./vercel-ai-gateway"
import {
	vercelFunctionRoutesSQL,
	vercelFunctionRouteTimeseriesSQL,
	vercelOneRouteTimeseriesSQL,
	vercelProjectDependenciesSQL,
	vercelProjectFunctionsSQL,
} from "./vercel-functions"
import {
	vercelAuditLogSQL,
	vercelSpeedInsightsSQL,
	vercelWebAnalyticsSummarySQL,
	vercelWebAnalyticsTopSQL,
} from "./vercel-event-drains"

const window = {
	orgId: OrgId.make("org_1"),
	startTime: "2026-07-02 00:00:00",
	endTime: "2026-07-03 00:00:00",
}
const bucketed = { ...window, bucketSeconds: 300 }
const project = { ...window, projectId: "prj_1" }

describe("vercelProjectRequestsSQL", () => {
	it("counts only records with a request method as requests, per project", () => {
		const { sql } = compileUnsafe(vercelProjectRequestsSQL(), window)
		expect(sql).toContain("FROM logs")
		expect(sql).toContain("logs.OrgId = 'org_1'")
		expect(sql).toContain("ResourceAttributes['cloud.provider'] = 'vercel'")
		expect(sql).toContain("countIf(logs.LogAttributes['http.request.method'] != '') AS requests")
		expect(sql).toContain("BETWEEN 500 AND 599)) AS requests5xx")
		expect(sql).toContain("countIf(logs.SeverityNumber >= 17) AS errorLogs")
		expect(sql).toContain("GROUP BY projectId")
	})

	it("counts stale and prerendered responses as served from cache", () => {
		const { sql } = compileUnsafe(vercelProjectRequestsSQL(), window)
		expect(sql).toContain(
			"countIf((logs.LogAttributes['http.request.method'] != '' AND logs.LogAttributes['vercel.cache'] IN ('HIT', 'STALE', 'PRERENDER'))) AS cacheHits",
		)
	})

	it("prunes partitions on the logs time key", () => {
		const { sql } = compileUnsafe(vercelProjectRequestsSQL(), window)
		expect(sql).toContain("logs.TimestampTime >= '2026-07-02 00:00:00'")
		expect(sql).toContain("logs.TimestampTime <= '2026-07-03 00:00:00'")
	})
})

describe("vercelRequestTimeseriesSQL", () => {
	it("reads every project unless one is given", () => {
		const fleet = compileUnsafe(vercelRequestTimeseriesSQL(), bucketed).sql
		const scoped = compileUnsafe(vercelRequestTimeseriesSQL({ projectId: "prj_1" }), bucketed).sql
		expect(fleet).not.toContain("vercel.project.id")
		expect(scoped).toContain("ResourceAttributes['vercel.project.id'] = 'prj_1'")
		expect(scoped).toContain("INTERVAL 300 SECOND")
		expect(scoped).toContain("GROUP BY bucket")
	})

	it("escapes a project id", () => {
		const { sql } = compileUnsafe(vercelRequestTimeseriesSQL({ projectId: "prj_'x" }), bucketed)
		expect(sql).toContain("= 'prj_\\'x'")
	})
})

describe("vercelProjectTopPathsSQL", () => {
	it("ranks one project's request paths", () => {
		const { sql } = compileUnsafe(vercelProjectTopPathsSQL(), project)
		expect(sql).toContain("ResourceAttributes['vercel.project.id'] = 'prj_1'")
		expect(sql).toContain("AND logs.LogAttributes['http.request.method'] != ''")
		expect(sql).toContain("countIf(logs.LogAttributes['vercel.cache'] != '') AS cacheLookups")
		expect(sql).toContain("ORDER BY requests DESC")
	})
})

describe("vercelProjectErrorLogsSQL", () => {
	it("reads the newest error and fatal lines with their traces, ungrouped", () => {
		const { sql } = compileUnsafe(vercelProjectErrorLogsSQL(), project)
		expect(sql).toContain("logs.SeverityNumber >= 17")
		expect(sql).toContain("LIMIT 2000")
		expect(sql).not.toContain("GROUP BY")
	})
})

describe("vercelProjectLatencySQL", () => {
	it("reads only the edge's request spans, by Vercel's project attribute", () => {
		const { sql } = compileUnsafe(vercelProjectLatencySQL(), window)
		expect(sql).toContain("FROM traces")
		expect(sql).toContain("AND mapContains(traces.ResourceAttributes, 'vercel.projectId')")
		expect(sql).toContain("AND traces.ResourceAttributes['vercel.projectId'] != ''")
		expect(sql).toContain(
			"((traces.ServiceName = 'vercel.edge-network' AND traces.SpanKind = 'Server') AND traces.SpanAttributes['http.response.status_code'] != '')",
		)
		expect(sql).toContain("quantile(0.95)(traces.Duration) / 1000000 AS p95DurationMs")
	})
})

const runtimeMarker =
	"(mapContains(traces.ResourceAttributes, 'maple_vercel.platform_service') AND traces.ResourceAttributes['maple_vercel.platform_service'] = 'vercel.serverless-runtime')"

describe("vercelProjectFunctionsSQL", () => {
	it("counts invocations and cold starts per project from runtime spans, found by the ingest marker", () => {
		const { sql } = compileUnsafe(vercelProjectFunctionsSQL(), window)
		expect(sql).toContain(runtimeMarker)
		expect(sql).not.toContain("traces.ServiceName =")
		expect(sql).toContain("countIf(traces.SpanName = 'Invoke Function') AS invocations")
		expect(sql).toContain("countIf(traces.SpanName = 'Start VM') AS coldStarts")
		expect(sql).toContain("GROUP BY projectId")
	})
})

describe("vercelOneRouteTimeseriesSQL", () => {
	it("scopes to the tenant, the project and the route", () => {
		const { sql } = compileUnsafe(vercelOneRouteTimeseriesSQL(), {
			...bucketed,
			projectId: "prj_1",
			route: "/api/checkout",
		})
		expect(sql).toContain("traces.OrgId = 'org_1'")
		expect(sql).toContain("traces.ResourceAttributes['vercel.projectId'] = 'prj_1'")
		expect(sql).toContain("'/api/checkout'")
		expect(compileUnsafe(vercelFunctionRouteTimeseriesSQL(), { ...bucketed, projectId: "prj_1" }).sql).not.toContain(
			"/api/checkout",
		)
	})
})

describe("vercelFunctionRoutesSQL", () => {
	it("joins invocations to the edge request's route per trace, within one project", () => {
		const { sql } = compileUnsafe(vercelFunctionRoutesSQL(), project)
		expect(sql).toContain(
			"anyIf(traces.SpanAttributes['http.route'], traces.ServiceName = 'vercel.edge-network') AS route",
		)
		expect(sql).toContain("traces.ResourceAttributes['vercel.projectId'] = 'prj_1'")
		expect(sql).toContain(runtimeMarker)
		expect(sql).toContain("GROUP BY traceId) AS t")
		expect(sql).toContain("WHERE t.traceInvocations > 0")
		expect(sql).toContain("GROUP BY route")
	})

	it("leaves warm traces out of the init percentiles", () => {
		const { sql } = compileUnsafe(vercelFunctionRoutesSQL(), project)
		expect(sql).toContain(
			"nullIf(sumIf(traces.Duration, traces.SpanName IN ('Start VM', 'Spawn Node.js', 'Init User Code')), 0) / 1000000 AS initMs",
		)
		expect(sql).toContain("quantile(0.95)(t.initMs) AS initP95Ms")
	})

	it("escapes a project id", () => {
		const { sql } = compileUnsafe(vercelFunctionRoutesSQL(), { ...window, projectId: "prj_'x" })
		expect(sql).toContain("= 'prj_\\'x'")
	})
})

describe("vercelProjectDependenciesSQL", () => {
	it("groups one project's runtime client spans by the host they called", () => {
		const { sql } = compileUnsafe(vercelProjectDependenciesSQL(), project)
		expect(sql).toContain(runtimeMarker)
		expect(sql).toContain("traces.SpanKind = 'Client'")
		expect(sql).toContain("traces.ResourceAttributes['vercel.projectId'] = 'prj_1'")
		expect(sql).toContain(
			"if(traces.SpanAttributes['server.address'] != '', traces.SpanAttributes['server.address'], traces.SpanAttributes['http.host']) AS host",
		)
	})

	it("counts an error status, a 5xx and a missing response as failures", () => {
		const { sql } = compileUnsafe(vercelProjectDependenciesSQL(), project)
		expect(sql).toContain(
			"countIf((traces.StatusCode = 'Error' OR toInt32OrZero(traces.SpanAttributes['http.status_code']) >= 500 OR toInt32OrZero(traces.SpanAttributes['http.status_code']) < 0)) AS errors",
		)
	})
})

describe("Speed Insights", () => {
	it("reads the p75 of each metric from the drain's service", () => {
		const { sql } = compileUnsafe(vercelSpeedInsightsSQL("metric"), window)
		expect(sql).toContain("logs.ServiceName = 'vercel-speed-insights'")
		expect(sql).toContain("logs.TimestampTime >= '2026-07-02 00:00:00'")
		expect(sql).toContain(
			"quantile(0.75)(toFloat64OrZero(logs.LogAttributes['vercel.speed_insights.value']))",
		)
		expect(sql).toContain("GROUP BY key, metric")
		expect(sql).not.toContain("vercel.project.id")
	})

	it("keys routes by Vercel's route, falling back to the path, and devices by type", () => {
		const scope = { projectId: "prj_1" }
		const routes = compileUnsafe(vercelSpeedInsightsSQL("route", scope), window).sql
		const devices = compileUnsafe(vercelSpeedInsightsSQL("device", scope), window).sql
		expect(routes).toContain(
			"if(logs.LogAttributes['vercel.route'] != '', logs.LogAttributes['vercel.route'], logs.LogAttributes['url.path']) AS key",
		)
		expect(devices).toContain("logs.LogAttributes['vercel.device.type'] AS key")
		for (const sql of [routes, devices])
			expect(sql).toContain("ResourceAttributes['vercel.project.id'] = 'prj_1'")
	})
})

describe("Web Analytics", () => {
	it("counts page views, their devices and custom events", () => {
		const { sql } = compileUnsafe(vercelWebAnalyticsSummarySQL(), window)
		expect(sql).toContain("logs.ServiceName = 'vercel-web-analytics'")
		expect(sql).toContain(
			"countIf(logs.LogAttributes['vercel.web_analytics.event.type'] = 'pageview') AS pageViews",
		)
		expect(sql).toContain(
			"countIf(logs.LogAttributes['vercel.web_analytics.event.type'] = 'event') AS customEvents",
		)
	})

	it("ranks page views by referrer and custom events by name, skipping empty values", () => {
		const referrers = compileUnsafe(vercelWebAnalyticsTopSQL("referrer"), window).sql
		const events = compileUnsafe(vercelWebAnalyticsTopSQL("event", { projectId: "prj_1" }), window).sql
		expect(referrers).toContain("logs.LogAttributes['vercel.web_analytics.event.type'] = 'pageview'")
		expect(referrers).toContain("logs.LogAttributes['http.request.header.referer'] != ''")
		expect(events).toContain("logs.LogAttributes['vercel.web_analytics.event.type'] = 'event'")
		expect(events).toContain("logs.LogAttributes['vercel.web_analytics.event.name'] AS value")
		expect(events).toContain("ResourceAttributes['vercel.project.id'] = 'prj_1'")
	})
})

describe("vercelAuditLogSQL", () => {
	it("lists the newest audit events, the actor by name or else id", () => {
		const { sql } = compileUnsafe(vercelAuditLogSQL(), window)
		expect(sql).toContain("logs.ServiceName = 'vercel-audit-log'")
		expect(sql).toContain(
			"if(logs.LogAttributes['vercel.audit.actor.name'] != '', logs.LogAttributes['vercel.audit.actor.name'], logs.LogAttributes['vercel.audit.actor.id']) AS actor",
		)
		expect(sql).toContain("ORDER BY timestamp DESC")
		expect(sql).toContain("LIMIT 25")
	})
})

describe("AI Gateway", () => {
	it("counts gateway server spans, parented or not, and sums the USD cost", () => {
		const { sql } = compileUnsafe(vercelAiGatewaySummarySQL(), window)
		expect(sql).toContain("traces.ServiceName = 'ai-gateway'")
		expect(sql).toContain("traces.SpanKind = 'Server'")
		expect(sql).not.toContain("ParentSpanId")
		expect(sql).toContain("ResourceAttributes['service.namespace'] = 'vercel'")
		expect(sql).toContain(
			"sumIf(toFloat64OrZero(traces.SpanAttributes['vercel.ai_gateway.cost.total']), traces.SpanAttributes['vercel.ai_gateway.cost.currency'] IN ('', 'USD')) AS costUsd",
		)
		expect(sql).toContain("gen_ai.usage.input_tokens")
		expect(sql).toContain("gen_ai.usage.output_tokens")
	})

	it("scopes to the calling project when given", () => {
		const scope = { projectId: "prj_1" }
		const compiled = [
			compileUnsafe(vercelAiGatewaySummarySQL(scope), window).sql,
			compileUnsafe(vercelAiGatewayByModelSQL(scope), window).sql,
			compileUnsafe(vercelAiGatewayTimeseriesSQL(scope), bucketed).sql,
		]
		for (const sql of compiled) expect(sql).toContain("SpanAttributes['vercel.project.id'] = 'prj_1'")
	})

	it("falls back to the requested model when no response model is set", () => {
		const { sql } = compileUnsafe(vercelAiGatewayByModelSQL(), window)
		expect(sql).toContain(
			"if(traces.SpanAttributes['gen_ai.response.model'] != '', traces.SpanAttributes['gen_ai.response.model'], traces.SpanAttributes['gen_ai.request.model']) AS model",
		)
	})

	it("groups usage by the calling project", () => {
		const { sql } = compileUnsafe(vercelAiGatewayByProjectSQL(), window)
		expect(sql).toContain("GROUP BY projectId")
	})
})
