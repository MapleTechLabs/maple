import { describe, expect, it } from "vitest"
import { compileUnsafe } from "@maple-dev/effect-orm/clickhouse"
import { OrgId } from "@maple/domain"
import {
	vercelProjectLatencySQL,
	vercelProjectRequestsSQL,
	vercelProjectTopErrorsSQL,
	vercelProjectTopPathsSQL,
	vercelRequestTimeseriesSQL,
} from "./vercel-infra"
import {
	vercelAiGatewayByModelSQL,
	vercelAiGatewayByProjectSQL,
	vercelAiGatewaySummarySQL,
	vercelAiGatewayTimeseriesSQL,
} from "./vercel-ai-gateway"

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
		expect(sql).toContain("LogAttributes['vercel.cache'] = 'HIT'")
		expect(sql).toContain("countIf(logs.SeverityNumber >= 17) AS errorLogs")
		expect(sql).toContain("GROUP BY projectId")
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
		expect(sql).toContain("LogAttributes['url.path'] AS path")
		expect(sql).toContain("ResourceAttributes['vercel.project.id'] = 'prj_1'")
		expect(sql).toContain("AND logs.LogAttributes['http.request.method'] != ''")
		expect(sql).toContain("countIf(logs.LogAttributes['vercel.cache'] != '') AS cacheLookups")
		expect(sql).toContain("ORDER BY requests DESC")
	})
})

describe("vercelProjectTopErrorsSQL", () => {
	it("groups error and fatal lines by their truncated message", () => {
		const { sql } = compileUnsafe(vercelProjectTopErrorsSQL(), project)
		expect(sql).toContain("leftUTF8(logs.Body, 200) AS message")
		expect(sql).toContain("logs.SeverityNumber >= 17")
		expect(sql).toContain("GROUP BY message")
	})
})

describe("vercelProjectLatencySQL", () => {
	it("reads request (server) spans of deployment traces by Vercel's project attribute", () => {
		const { sql } = compileUnsafe(vercelProjectLatencySQL(), window)
		expect(sql).toContain("FROM traces")
		expect(sql).toContain("ResourceAttributes['vercel.projectId'] AS projectId")
		expect(sql).toContain("AND mapContains(traces.ResourceAttributes, 'vercel.projectId')")
		expect(sql).toContain("AND traces.ResourceAttributes['vercel.projectId'] != ''")
		expect(sql).toContain("traces.SpanKind = 'Server'")
		expect(sql).toContain("quantile(0.95)(traces.Duration) / 1000000 AS p95DurationMs")
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
		expect(sql).toContain("SpanAttributes['vercel.project.id'] AS projectId")
		expect(sql).toContain("GROUP BY projectId")
	})
})
