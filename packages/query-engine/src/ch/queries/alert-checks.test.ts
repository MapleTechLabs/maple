import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect } from "effect"
import { compile, compileUnsafe } from "@maple-dev/effect-orm/clickhouse"
import { alertCheckGroupTotalsQuery, alertChecksSummaryQuery, listRuleChecksQuery } from "./alert-checks"
import { OrgId } from "@maple/domain"

const utc = (iso: string) => DateTime.makeUnsafe(iso)

const baseParams = {
	orgId: OrgId.make("org_1"),
	ruleId: "rule_1",
}

describe("listRuleChecksQuery", () => {
	it("compiles the minimal query with OrgId + RuleId", () => {
		const q = listRuleChecksQuery({ limit: 500 })
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("FROM alert_checks")
		expect(sql).toContain("alert_checks.Timestamp AS timestamp")
		expect(sql).toContain("alert_checks.WindowStart AS windowStart")
		expect(sql).toContain("alert_checks.WindowEnd AS windowEnd")
		expect(sql).toContain("OrgId = 'org_1'")
		expect(sql).toContain("RuleId = 'rule_1'")
		expect(sql).toContain("ORDER BY timestamp DESC, groupKey ASC")
		expect(sql).toContain("LIMIT 500")
		expect(sql).toContain("FORMAT JSON")
		// No optional filters present
		expect(sql).not.toContain("GroupKey =")
		expect(sql).not.toContain("Timestamp >=")
		expect(sql).not.toContain("Timestamp <=")
	})

	it("applies groupKey filter when provided", () => {
		const q = listRuleChecksQuery({ limit: 100, groupKey: "svc=api" })
		const { sql } = compileUnsafe(q, { ...baseParams, groupKey: "svc=api" })
		expect(sql).toContain("GroupKey = 'svc=api'")
	})

	it("omits groupKey filter when empty string", () => {
		const q = listRuleChecksQuery({ limit: 100, groupKey: "" })
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).not.toContain("GroupKey =")
	})

	it("applies since/until filters when provided", () => {
		const q = listRuleChecksQuery({
			limit: 100,
			since: utc("2024-01-01T00:00:00.250Z"),
			until: utc("2024-01-02T00:00:00.250Z"),
		})
		const { sql } = compileUnsafe(q, {
			...baseParams,
			since: utc("2024-01-01T00:00:00.250Z"),
			until: utc("2024-01-02T00:00:00.250Z"),
		})
		expect(sql).toContain("Timestamp >= '2024-01-01 00:00:00.250'")
		expect(sql).toContain("Timestamp <= '2024-01-02 00:00:00.250'")
	})

	it("escapes single quotes in orgId", () => {
		const q = listRuleChecksQuery({ limit: 10 })
		const { sql } = compileUnsafe(q, { orgId: OrgId.make("org'evil"), ruleId: "rule_1" })
		expect(sql).toContain("OrgId = 'org\\'evil'")
	})

	it("applies status and the compound keyset cursor", () => {
		const q = listRuleChecksQuery({
			limit: 42,
			status: "breached",
			beforeTimestamp: utc("2024-01-02T03:04:05.250Z"),
			beforeGroupKey: "svc=worker",
		})
		const { sql } = compileUnsafe(q, {
			...baseParams,
			status: "breached",
			beforeTimestamp: utc("2024-01-02T03:04:05.250Z"),
			beforeGroupKey: "svc=worker",
		})
		expect(sql).toContain("LIMIT 42")
		expect(sql).toContain("Status = 'breached'")
		expect(sql).toContain("Timestamp < '2024-01-02 03:04:05.250'")
		expect(sql).toContain("GroupKey > 'svc=worker'")
		expect(sql).not.toContain("OFFSET")
	})
})

describe("alert history summaries", () => {
	it("limits the group-ranking query", () => {
		const { sql } = compileUnsafe(
			alertCheckGroupTotalsQuery({
				since: utc("2024-01-01T00:00:00Z"),
				until: utc("2024-12-31T23:59:59Z"),
				limit: 20,
			}),
			{
				...baseParams,
				since: utc("2024-01-01T00:00:00Z"),
				until: utc("2024-12-31T23:59:59Z"),
			},
		)
		expect(sql).toContain("GROUP BY groupKey")
		expect(sql).toContain("ORDER BY totalCount DESC")
		expect(sql).toContain("LIMIT 20")
	})

	it("buckets top groups and folds the remainder into other", () => {
		const { sql } = compileUnsafe(
			alertChecksSummaryQuery({
				topGroupKeys: ["svc=api", "svc=worker"],
			}),
			{
				...baseParams,
				since: utc("2024-01-01T00:00:00Z"),
				until: utc("2024-12-31T23:59:59Z"),
				bucketSeconds: 43_200,
			},
		)
		expect(sql).toContain("toStartOfInterval")
		expect(sql).toContain("43200")
		expect(sql).toContain("'__other__'")
		expect(sql).toContain("countIf")
	})
})

// Rows reach callers through `decodeRows`. A query whose row schema is not
// derived passes rows through untouched, and its timestamps would stay strings
// behind a `DateTime.Utc` type.
describe("alert check rows decode timestamps to DateTime.Utc", () => {
	const params = { ...baseParams, since: utc("2024-01-01T00:00:00Z"), until: utc("2024-01-02T00:00:00Z") }

	it.effect("listRuleChecksQuery", () =>
		Effect.gen(function* () {
			const compiled = yield* compile(listRuleChecksQuery({ limit: 1 }), baseParams)
			expect(compiled.rowSchemaSource).toBe("derived")
			const [row] = yield* compiled.decodeRows([
				{
					timestamp: "2024-01-01 10:00:00.250",
					windowStart: "2024-01-01 09:55:00.000",
					windowEnd: "2024-01-01 10:00:00.000",
					groupKey: "",
					status: "healthy",
					signalType: "error_rate",
					comparator: "gt",
					threshold: 1,
					observedValue: null,
					sampleCount: 0,
					windowMinutes: 5,
					consecutiveBreaches: 0,
					consecutiveHealthy: 1,
					incidentId: null,
					incidentTransition: "none",
					evaluationDurationMs: 3,
					errorMessage: null,
					errorCategory: "",
					skipReason: "",
				},
			])
			expect(DateTime.formatIso(row!.timestamp)).toBe("2024-01-01T10:00:00.250Z")
			expect(DateTime.formatIso(row!.windowEnd)).toBe("2024-01-01T10:00:00.000Z")
		}),
	)

	it.effect("alertChecksSummaryQuery", () =>
		Effect.gen(function* () {
			const compiled = yield* compile(alertChecksSummaryQuery({ topGroupKeys: [] }), {
				...params,
				bucketSeconds: 60,
			})
			expect(compiled.rowSchemaSource).toBe("derived")
			const [row] = yield* compiled.decodeRows([
				{
					bucket: "2024-01-01 10:00:00.000",
					groupKey: "__other__",
					totalCount: 1,
					breachedCount: 0,
					healthyCount: 1,
					skippedCount: 0,
					errorCount: 0,
					transitionCount: 0,
					observedValue: null,
					threshold: 1,
				},
			])
			expect(DateTime.toEpochMillis(row!.bucket)).toBe(Date.UTC(2024, 0, 1, 10))
		}),
	)
})
