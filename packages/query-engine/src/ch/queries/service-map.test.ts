import { describe, expect, it } from "vitest"
import { serviceExternalEdgesSQL } from "./service-map"
import { serviceMapResolutionsRollupSQL } from "./service-map-rollup"

const baseParams = {
	orgId: "org_1",
	startTime: "2024-01-01 00:00:00",
	endTime: "2024-01-02 00:00:00",
}

// ---------------------------------------------------------------------------
// serviceExternalEdgesSQL
// ---------------------------------------------------------------------------

describe("serviceExternalEdgesSQL", () => {
	it("scopes by org, service, and time window", () => {
		const { sql } = serviceExternalEdgesSQL({ serviceName: "artifacts-api" }, baseParams)
		expect(sql).toContain("OrgId = 'org_1'")
		expect(sql).toContain("ServiceName = 'artifacts-api'")
		expect(sql).toContain("toStartOfHour(toDateTime('2024-01-01 00:00:00'))")
		expect(sql).toContain("toStartOfHour(toDateTime('2024-01-02 00:00:00'))")
	})

	it("unions hourly MV branch with raw-traces fallback for the in-progress hour", () => {
		const { sql } = serviceExternalEdgesSQL({ serviceName: "artifacts-api" }, baseParams)
		expect(sql).toContain("FROM service_external_edges_hourly")
		expect(sql).toContain("FROM traces")
		expect(sql).toContain("UNION ALL")
		// Recent branch must filter to the in-progress hour [endHour, endTime].
		expect(sql).toContain("Timestamp >= toStartOfHour(toDateTime('2024-01-02 00:00:00'))")
	})

	it("excludes db.system.name from the raw-traces branch (DB edges are a separate MV)", () => {
		const { sql } = serviceExternalEdgesSQL({ serviceName: "artifacts-api" }, baseParams)
		expect(sql).toContain("SpanAttributes['db.system.name'] = ''")
	})

	it("applies messaging > rpc > http precedence in the multiIf", () => {
		const { sql } = serviceExternalEdgesSQL({ serviceName: "artifacts-api" }, baseParams)
		// First branch of multiIf must be the messaging predicate.
		const multiIfIdx = sql.indexOf("multiIf(")
		expect(multiIfIdx).toBeGreaterThan(-1)
		const after = sql.slice(multiIfIdx, multiIfIdx + 400)
		const msgIdx = after.indexOf("'messaging'")
		const rpcIdx = after.indexOf("'rpc'")
		const httpIdx = after.indexOf("'http'")
		expect(msgIdx).toBeGreaterThan(-1)
		expect(rpcIdx).toBeGreaterThan(-1)
		expect(httpIdx).toBeGreaterThan(-1)
		expect(msgIdx).toBeLessThan(rpcIdx)
		expect(rpcIdx).toBeLessThan(httpIdx)
	})

	it("anti-joins internal-service overlap from the resolutions table for HTTP only", () => {
		const { sql } = serviceExternalEdgesSQL({ serviceName: "artifacts-api" }, baseParams)
		expect(sql).toContain("FROM service_address_resolutions_hourly")
		expect(sql).toContain("targetType = 'http'")
		expect(sql).toContain("targetName IN (")
	})

	it("threads deploymentEnv into both branches and the resolutions anti-join", () => {
		const { sql } = serviceExternalEdgesSQL(
			{ serviceName: "artifacts-api", deploymentEnv: "production" },
			baseParams,
		)
		expect(sql).toContain("DeploymentEnv = 'production'")
		expect(sql).toContain("ResourceAttributes['deployment.environment'] = 'production'")
	})

	it("groups by target identity and orders by callCount desc", () => {
		const { sql } = serviceExternalEdgesSQL({ serviceName: "artifacts-api" }, baseParams)
		expect(sql).toContain("GROUP BY sourceService, targetType, targetSystem, targetName")
		expect(sql).toContain("ORDER BY callCount DESC")
		expect(sql).toContain("LIMIT 200")
		expect(sql).toContain("FORMAT JSON")
	})

	it("escapes single quotes in serviceName / orgId to prevent SQL injection", () => {
		const { sql } = serviceExternalEdgesSQL(
			{ serviceName: "weird'service" },
			{ ...baseParams, orgId: "org'attack" },
		)
		expect(sql).toContain("ServiceName = 'weird\\'service'")
		expect(sql).toContain("OrgId = 'org\\'attack'")
	})
})

// ---------------------------------------------------------------------------
// serviceMapResolutionsRollupSQL — companion of the edges rollup
// ---------------------------------------------------------------------------

describe("serviceMapResolutionsRollupSQL", () => {
	const hourParams = {
		orgId: "org_1",
		hourStart: "2024-01-01 00:00:00",
		hourEnd: "2024-01-01 01:00:00",
	}

	it("joins parent Client/Producer spans to child Server/Consumer spans", () => {
		const { sql } = serviceMapResolutionsRollupSQL(hourParams)
		expect(sql).toContain("SpanKind IN ('Client', 'Producer')")
		expect(sql).toContain("SpanKind IN ('Server', 'Consumer')")
		expect(sql).toContain("ON (p.SpanId = c.ParentSpanId AND p.TraceId = c.TraceId)")
	})

	it("projects parent server.address as the resolution key", () => {
		const { sql } = serviceMapResolutionsRollupSQL(hourParams)
		// Map lookup is pushed into the parent subquery as `ServerAddress`, so the
		// outer SELECT reads a flat column instead of re-evaluating the map.
		expect(sql).toContain("SpanAttributes['server.address'] AS ServerAddress")
		expect(sql).toContain("p.ServerAddress AS ParentServerAddress")
		expect(sql).toContain("c.ServiceName AS ResolvedTargetService")
	})

	it("hour-buckets via toStartOfHour, scopes by org", () => {
		const { sql } = serviceMapResolutionsRollupSQL(hourParams)
		expect(sql).toContain("toStartOfHour(p.Timestamp) AS Hour")
		expect(sql).toContain("OrgId = 'org_1'")
	})

	it("drops same-service edges and empty server.address", () => {
		const { sql } = serviceMapResolutionsRollupSQL(hourParams)
		expect(sql).toContain("p.ServiceName != c.ServiceName")
		expect(sql).toContain("SpanAttributes['server.address'] != ''")
	})

	it("bounds the join to a single hour on both sides", () => {
		const { sql } = serviceMapResolutionsRollupSQL(hourParams)
		expect(sql).toContain("Timestamp >= '2024-01-01 00:00:00'")
		expect(sql).toContain("Timestamp < '2024-01-01 01:00:00'")
		// Both branches must enforce the hour bound — count occurrences.
		const matches = sql.match(/Timestamp >= '2024-01-01 00:00:00'/g)
		expect(matches?.length).toBe(2)
	})

	it("groups by the resolution key tuple and formats as JSON", () => {
		const { sql } = serviceMapResolutionsRollupSQL(hourParams)
		expect(sql).toContain(
			"GROUP BY OrgId, Hour, SourceService, ParentServerAddress, ResolvedTargetService, DeploymentEnv",
		)
		expect(sql).toContain("FORMAT JSON")
	})
})
