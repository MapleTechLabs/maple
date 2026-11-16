import { describe, expect, it } from "@effect/vitest"
import { String as Str } from "effect"
import { compileUnsafe } from "@maple-dev/effect-orm/clickhouse"
import { OrgId } from "@maple/domain"
import {
	PROFILE_STACKS_CAP,
	profileSampleTypesQuery,
	profileStacksQuery,
	profileTimeseriesQuery,
} from "./profiles"

// What the queries return is exercised against real rows through Maple Local's embedded
// ClickHouse; these pin the scoping every read depends on.

const params = {
	orgId: OrgId.make("org_1"),
	startTime: "2026-11-15 00:00:00",
	endTime: "2026-11-15 12:00:00",
	serviceName: "checkout",
	sampleType: "cpu",
	sampleUnit: "nanoseconds",
	traceId: "0af7651916cd43dd8448eb211c80319c",
	bucketSeconds: 60,
}

const oneLine = (sql: string): string => Str.replace(/\s+/g, " ")(sql)

const compiled = {
	stacks: (opts: Parameters<typeof profileStacksQuery>[0]) =>
		oneLine(compileUnsafe(profileStacksQuery(opts), params).sql),
	types: (opts: Parameters<typeof profileSampleTypesQuery>[0]) =>
		oneLine(compileUnsafe(profileSampleTypesQuery(opts), params).sql),
	timeseries: (opts: Parameters<typeof profileTimeseriesQuery>[0]) =>
		oneLine(compileUnsafe(profileTimeseriesQuery(opts), params).sql),
}

describe("profile queries", () => {
	it.each([
		["stacks", compiled.stacks({ service: true })],
		["sample types", compiled.types({ service: true })],
		["timeseries", compiled.timeseries({ service: true })],
	])("%s read only the caller's org, service and window", (_name, sql) => {
		expect(sql).toContain("profiles.OrgId = 'org_1'")
		expect(sql).toContain("profiles.ServiceName = 'checkout'")
		expect(sql).toContain("profiles.Timestamp >= '2026-11-15 00:00:00'")
		expect(sql).toContain("profiles.Timestamp <= '2026-11-15 12:00:00'")
	})

	it("ranks stacks by value, caps them, and reports what the cap cut off", () => {
		const sql = compiled.stacks({ service: true })
		expect(sql).toContain("toString(profiles.StackHash) AS stackHash")
		expect(sql).toContain("sum(sum(Value)) OVER () AS totalValue")
		expect(sql).toContain("GROUP BY stackHash ORDER BY value DESC, stackHash ASC")
		expect(sql).toContain(`LIMIT ${PROFILE_STACKS_CAP}`)
		expect(compiled.stacks({ service: true, limit: 250 })).toContain("LIMIT 250")
	})

	it("reads one sample type, and one unit of it when asked", () => {
		expect(compiled.stacks({ service: true })).not.toContain("SampleUnit =")
		const sql = compiled.stacks({ service: true, unit: true })
		expect(sql).toContain("profiles.SampleType = 'cpu'")
		expect(sql).toContain("profiles.SampleUnit = 'nanoseconds'")
		expect(compiled.timeseries({ service: true, unit: true })).toContain(
			"profiles.SampleUnit = 'nanoseconds'",
		)
	})

	it("lists a sample type once per unit, so two units of one type are never added together", () => {
		expect(compiled.types({ service: true })).toContain("GROUP BY sampleType, sampleUnit")
	})

	it("scopes a span read to the trace and the listed spans, escaping the ids", () => {
		const sql = compiled.stacks({ trace: true, spanIds: ["b7ad6b7169203331", "it's"] })
		expect(sql).toContain("profiles.TraceId = '0af7651916cd43dd8448eb211c80319c'")
		expect(sql).toContain("'b7ad6b7169203331'")
		expect(sql).toContain("'it\\'s'")
		expect(sql).not.toContain("ServiceName =")
	})

	it("matches nothing for an empty span list instead of compiling `IN ()`", () => {
		const sql = compiled.types({ trace: true, spanIds: [] })
		expect(sql).toContain("1 = 0")
		expect(sql).not.toContain("IN ()")
	})

	it("is pinned to managed storage, where profiles are written", () => {
		expect(compileUnsafe(profileStacksQuery({ service: true }), params).route).toBe("ingest")
	})
})
