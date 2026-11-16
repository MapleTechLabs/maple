import { describe, expect, it } from "@effect/vitest"
import { compileUnsafe } from "@maple-dev/effect-orm/clickhouse"
import { OrgId } from "@maple/domain"
import { cloudResourceServicesQuery } from "./cloud-resources"

const compiled = () =>
	compileUnsafe(
		cloudResourceServicesQuery({
			candidates: [
				{ key: "host.id", value: "i-0abc", scope: null },
				{
					key: "faas.name",
					value: "checkout-fn",
					scope: { accountId: "111111111111", region: "us-east-1" },
				},
			],
		}),
		{
			orgId: OrgId.make("org_1"),
			startTime: "2026-11-15 00:00:00",
			endTime: "2026-11-16 00:00:00",
		},
	).sql

describe("cloudResourceServicesQuery", () => {
	it("reads only the org's entry-point spans in the window", () => {
		const sql = compiled()
		expect(sql).toContain("traces.OrgId = 'org_1'")
		expect(sql).toContain("traces.IsEntryPoint = 1")
		expect(sql).toContain("traces.Timestamp >= '2026-11-15 00:00:00'")
	})

	it("matches each value only on the attribute that would carry it", () => {
		const sql = compiled()
		expect(sql).toContain("hasAny(mapValues(traces.ResourceAttributes), ['i-0abc', 'checkout-fn'])")
		expect(sql).toContain("traces.ResourceAttributes['host.id'] IN ('i-0abc')")
		expect(sql).toContain("traces.ResourceAttributes['faas.name'] IN ('checkout-fn')")
		expect(sql).not.toContain("k8s.cluster.name")
	})

	it("scopes a name to the finding's account and region", () => {
		const sql = compiled()
		expect(sql).toContain("traces.ResourceAttributes['cloud.account.id'] IN ('', '111111111111')")
		expect(sql).toContain("traces.ResourceAttributes['cloud.region'] IN ('', 'us-east-1')")
	})

	it("groups by the matched candidate and service, busiest first", () => {
		const sql = compiled()
		expect(sql).toContain("GROUP BY match, service")
		expect(sql).toContain("ORDER BY requests DESC")
	})
})
