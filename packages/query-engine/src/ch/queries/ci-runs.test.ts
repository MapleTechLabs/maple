import { describe, expect, it } from "vitest"
import { DateTime } from "effect"
import { compileUnsafe } from "@maple-dev/effect-orm/clickhouse"
import { OrgId } from "@maple/domain"
import {
	ciJobStatsQuery,
	ciPipelineStatsQuery,
	ciQueueTotalsQuery,
	ciRedStreak,
	ciRunSeriesQuery,
	ciRunsSpanMs,
	ciRunTotalsQuery,
	ciRunsQuery,
} from "./ci-runs"

const baseParams = {
	orgId: OrgId.make("org_1"),
	startTime: "2026-10-01 00:00:00",
	endTime: "2026-10-08 00:00:00",
}

const scope = { owner: "acme", repository: "api", pipeline: "CI" }

describe("ci run analytics", () => {
	it.each([
		["totals", () => compileUnsafe(ciRunTotalsQuery(scope), baseParams).sql],
		["workflow stats", () => compileUnsafe(ciPipelineStatsQuery(scope), baseParams).sql],
	])("reads only the org's ran workflow runs in the scope (%s)", (_name, compile) => {
		const sql = compile()
		expect(sql).toContain("OrgId = 'org_1'")
		expect(sql).toContain("ServiceName = 'github-actions'")
		expect(sql).toContain("traces.ParentSpanId = ''")
		expect(sql).toContain("traces.SpanAttributes['cicd.pipeline.result'] != 'skip'")
		expect(sql).toContain("traces.ResourceAttributes['vcs.owner.name'] = 'acme'")
		expect(sql).toContain("traces.ResourceAttributes['vcs.repository.name'] = 'api'")
		expect(sql).toContain("traces.SpanAttributes['cicd.pipeline.name'] = 'CI'")
	})

	it("counts timeouts and errors as failures, cancellations apart", () => {
		const { sql } = compileUnsafe(ciRunTotalsQuery({}), baseParams)
		expect(sql).toContain(
			"countIf(traces.SpanAttributes['cicd.pipeline.result'] IN ('failure', 'timeout', 'error'))",
		)
		expect(sql).toContain("countIf(traces.SpanAttributes['cicd.pipeline.result'] = 'cancellation')")
		expect(sql).not.toContain("vcs.owner.name")
	})

	it("buckets the series by the requested interval", () => {
		const { sql } = compileUnsafe(ciRunSeriesQuery({}), { ...baseParams, bucketSeconds: 86_400 })
		expect(sql).toContain("toStartOfInterval(traces.Timestamp, INTERVAL 86400 SECOND)")
		expect(sql).toContain("GROUP BY bucket")
	})

	it("keeps each workflow's latest result", () => {
		const { sql } = compileUnsafe(ciPipelineStatsQuery({ limit: 20 }), baseParams)
		expect(sql).toContain("argMax(traces.SpanAttributes['cicd.pipeline.result'], traces.Timestamp)")
		expect(sql).toContain("GROUP BY owner, repository, pipeline")
		expect(sql).toContain("LIMIT 20")
	})
})

describe("ci job analytics", () => {
	it.each([
		["job stats", () => compileUnsafe(ciJobStatsQuery({}), baseParams).sql],
		["queue totals", () => compileUnsafe(ciQueueTotalsQuery({}), baseParams).sql],
	])("reads job spans that ran, not steps or runner waits (%s)", (_name, compile) => {
		const sql = compile()
		expect(sql).toContain("OrgId = 'org_1'")
		expect(sql).toContain("traces.SpanAttributes['cicd.pipeline.task.name'] != ''")
		expect(sql).toContain("traces.SpanAttributes['maple.cicd.step.number'] = ''")
		expect(sql).toContain("traces.SpanAttributes['cicd.pipeline.task.run.result'] != 'skip'")
		expect(sql).toContain("toFloat64OrZero(traces.SpanAttributes['maple.cicd.queue_duration_ms'])")
		expect(sql).toContain("traces.Duration > 0")
	})

	it("ranks jobs by the CI time they take", () => {
		const { sql } = compileUnsafe(ciJobStatsQuery({}), baseParams)
		expect(sql).toContain("GROUP BY owner, repository, pipeline, job")
		expect(sql).toContain("ORDER BY totalDurationMs DESC")
		expect(sql).toContain("countIf(traces.SpanAttributes['maple.cicd.run_attempt'] != '1')")
	})
})

describe("ciRunsQuery", () => {
	it("pages newest first after the cursor run", () => {
		const { sql } = compileUnsafe(
			ciRunsQuery({
				pullRequest: 42,
				owner: "acme",
				before: { startedAt: DateTime.makeUnsafe("2026-10-05T12:00:00Z"), traceId: "abc" },
				limit: 51,
			}),
			{
				...baseParams,
				beforeStartedAt: DateTime.makeUnsafe("2026-10-05T12:00:00Z"),
				beforeTraceId: "abc",
			},
		)
		expect(sql).toContain("traces.SpanAttributes['vcs.change.id'] = '42'")
		expect(sql).toContain("traces.ResourceAttributes['vcs.owner.name'] = 'acme'")
		expect(sql).toContain("traces.TraceId < 'abc'")
		expect(sql).toContain("ORDER BY startedAt DESC, traceId DESC")
		expect(sql).toContain("LIMIT 51")
	})

	it("reads every run when no cursor is given", () => {
		const { sql } = compileUnsafe(ciRunsQuery({}), baseParams)
		expect(sql).not.toContain("traces.TraceId <")
		expect(sql).not.toContain("!= 'skip'")
	})

	it("leaves skipped runs out when asked", () => {
		const { sql } = compileUnsafe(ciRunsQuery({ ranOnly: true }), baseParams)
		expect(sql).toContain("traces.SpanAttributes['cicd.pipeline.result'] != 'skip'")
	})
})

describe("ciRunsSpanMs", () => {
	it("covers every run from the first start to a second past the last end", () => {
		const at = (iso: string) => DateTime.makeUnsafe(iso)
		const span = ciRunsSpanMs([
			{ startedAt: at("2026-10-05T12:00:00Z"), durationMs: 600_000 },
			{ startedAt: at("2026-10-05T11:00:00Z"), durationMs: 60_000 },
		])
		expect(span?.startMs).toBe(Date.parse("2026-10-05T11:00:00Z"))
		expect(span?.endMs).toBe(Date.parse("2026-10-05T12:10:01Z"))
	})

	it("is absent for no runs", () => {
		expect(ciRunsSpanMs([])).toBeUndefined()
	})
})

describe("ciRedStreak", () => {
	const run = (result: string, revision: string) => ({ result, revision })

	it("is absent when the latest judged run passed", () => {
		expect(
			ciRedStreak([run("cancellation", "c"), run("success", "b"), run("failure", "a")]),
		).toBeUndefined()
	})

	it("counts failures back to the last green run, skipping runs without a verdict", () => {
		const streak = ciRedStreak([
			run("failure", "d"),
			run("cancellation", "c"),
			run("timeout", "b"),
			run("success", "a"),
		])
		expect(streak?.failedRuns).toBe(2)
		expect(streak?.firstFailed.revision).toBe("b")
		expect(streak?.lastGreen?.revision).toBe("a")
	})

	it("has no last green run when nothing passed", () => {
		const streak = ciRedStreak([run("failure", "b"), run("error", "a")])
		expect(streak?.failedRuns).toBe(2)
		expect(streak?.lastGreen).toBeUndefined()
	})
})
