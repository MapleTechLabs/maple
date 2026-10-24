import { describe, expect, it } from "vitest"
import { compileUnsafe } from "@maple-dev/effect-orm/clickhouse"
import { OrgId } from "@maple/domain"
import { awsIngestQuery } from "./aws-ingest"

const params = {
	orgId: OrgId.make("org_1"),
	connectionId: "018f2b3c-4d5e-4f70-8192-a3b4c5d6e7f8",
	startTime: "2026-10-23 09:00:00",
	endTime: "2026-10-23 10:00:00",
}

describe("awsIngestQuery", () => {
	it("counts one connection's CloudWatch points per namespace and region, inside the org", () => {
		const { sql } = compileUnsafe(awsIngestQuery(), params)

		expect(sql).toMatch(/FROM metrics_sum/)
		expect(sql).toMatch(/OrgId = 'org_1'/)
		expect(sql).toContain("'018f2b3c-4d5e-4f70-8192-a3b4c5d6e7f8'")
		expect(sql).toContain("'maple_aws_connection_id'")
		expect(sql).toContain("'aws.cloudwatch.metric_stream'")
		// One `.count` row per CloudWatch point: the gauges would count each point up to four times.
		expect(sql).toContain("LIKE 'aws.%.count'")
		expect(sql).toMatch(/GROUP BY namespace, region/)
		expect(sql).toContain("groupUniqArray(8)(ServiceName)")
	})
})
