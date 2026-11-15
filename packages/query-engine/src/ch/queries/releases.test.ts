import { describe, expect, it } from "vitest"
import { compileUnsafe } from "@maple-dev/effect-orm/clickhouse"
import { releasesListQuery } from "./releases"
import { OrgId } from "@maple/domain"

const baseParams = {
	orgId: OrgId.make("org_1"),
	startTime: "2024-01-01 00:00:00",
	endTime: "2024-01-02 00:00:00",
}

describe("releasesListQuery", () => {
	it("groups the service-window splice by service, environment and commit", () => {
		const { sql } = compileUnsafe(
			releasesListQuery({ environments: ["production"], serviceNames: ["api", "web"] }),
			baseParams,
		)
		expect(sql).toContain("FROM service_overview_spans")
		expect(sql).toContain("FROM service_overview_hourly")
		expect(sql).toContain("OrgId = 'org_1'")
		expect(sql).toContain("DeploymentEnv IN ('production')")
		expect(sql).toContain("bServiceName IN ('api', 'web')")
		expect(sql).toContain("bCommitSha NOT IN ('', 'unknown', 'N/A')")
		expect(sql).toContain("GROUP BY serviceName, environment, commitSha")
		expect(sql).toContain("quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles)")
		expect(sql).toContain("ORDER BY firstSeen DESC, spanCount DESC")
		expect(sql).toContain("LIMIT 500")
	})

	it("scopes to one service", () => {
		const { sql } = compileUnsafe(releasesListQuery({ serviceName: "api", limit: 50 }), baseParams)
		expect(sql).toContain("ServiceName = 'api'")
		expect(sql).toContain("LIMIT 50")
	})
})
