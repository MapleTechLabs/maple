import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as CH from "@maple/query-engine/ch"
import { OrgId } from "@maple/domain"
import { DateTime, Effect, Schema } from "effect"
import schemaSql from "../src/server/schema/local-schema.sql" with { type: "text" }
import { Chdb } from "../src/server/chdb"
import { decodeJsonEachRow } from "../src/server/chdb-rows"
import { describeWithChdb } from "./libchdb-test-support"

// Two orgs with the same telemetry shape, told apart only by OrgId and a name
// prefix. A query scoped to org A that returns any `b-` value read org B's rows,
// whichever branch, tier or join side dropped its OrgId predicate.

const HOUR_MS = 3_600_000
const ORG_A = OrgId.make("org_isolation_a")
const ORG_B = OrgId.make("org_isolation_b")
const RULE_ID = "rule_isolation"
const iso = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace("Z", "")
const seconds = (ms: number) => iso(ms).slice(0, 19)

const decodeOverview = decodeJsonEachRow(
	Schema.Struct({ serviceName: Schema.String, spanCount: CH.CHNumber }),
)

const nowMs = Date.now()
const currentHourMs = Math.floor(nowMs / HOUR_MS) * HOUR_MS
// Inside a full hour of the window, so the rollup tiers answer for it.
const interiorMs = currentHourMs - 3 * HOUR_MS + 10 * 60_000
// In the trailing partial hour, so the raw tier answers for it, even in an hour's first minute.
const edgeMs = Math.max(currentHourMs, nowMs - 60_000)
const window = { startTime: seconds(currentHourMs - 5 * HOUR_MS + 30_000), endTime: seconds(nowMs) }

/** A `<prefix>-front` Client span calling a `<prefix>-api` Server span at `atMs`.
 * Trace and span ids are the same in both orgs, so only OrgId keeps a join from pairing
 * one org's parent with the other's child. */
const callRows = (orgId: string, prefix: string, atMs: number): string => {
	const traceId = `trace-${atMs}`
	const client = `('${orgId}', '${iso(atMs)}', '${traceId}', 'c-${atMs}', '', 'GET /api', 'Client', '${prefix}-front', 5000000, 'Ok', map('server.address', 'api.internal'))`
	const server = `('${orgId}', '${iso(atMs + 1)}', '${traceId}', 's-${atMs}', 'c-${atMs}', 'GET /api', 'Server', '${prefix}-api', 4000000, 'Ok', map())`
	return `${client}, ${server}`
}

const checkRow = (orgId: string, prefix: string) =>
	`('${orgId}', '${RULE_ID}', '${prefix}-group', '${iso(interiorMs)}', 'healthy', 'error_rate', 'gt', 1, 0.5, 10, 5, '${iso(interiorMs - 300_000)}', '${iso(interiorMs)}', 0, 1, NULL, '', 3, NULL, '')`

describeWithChdb("tenant isolation against two orgs' rows", () => {
	let root = ""
	let db: Chdb

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "maple-tenant-isolation-"))
		db = Chdb.open({ dataDir: join(root, "data"), schemaSql })
		const spans = [ORG_A, ORG_B].flatMap((orgId) => {
			const prefix = orgId === ORG_A ? "a" : "b"
			// Two calls in the hourly tier and one in the raw tier: only both together count three.
			return [
				callRows(orgId, prefix, interiorMs),
				callRows(orgId, prefix, interiorMs + 60_000),
				callRows(orgId, prefix, edgeMs),
			]
		})
		db.exec(
			`INSERT INTO traces (OrgId, Timestamp, TraceId, SpanId, ParentSpanId, SpanName, SpanKind, ServiceName, Duration, StatusCode, SpanAttributes) VALUES ${spans.join(", ")}`,
		)
		db.exec(
			`INSERT INTO alert_checks (OrgId, RuleId, GroupKey, Timestamp, Status, SignalType, Comparator, Threshold, ObservedValue, SampleCount, WindowMinutes, WindowStart, WindowEnd, ConsecutiveBreaches, ConsecutiveHealthy, IncidentId, IncidentTransition, EvaluationDurationMs, ErrorMessage, ErrorCategory) VALUES ${checkRow(ORG_A, "a")}, ${checkRow(ORG_B, "b")}`,
		)
	})

	afterAll(() => {
		db?.close()
		if (root) rmSync(root, { recursive: true, force: true })
	})

	/** The raw JSONEachRow output of a compiled query run as org A. */
	const runAsOrgA = async (compiled: Effect.Effect<{ readonly sql: string }, unknown>) => {
		const { sql } = await Effect.runPromise(compiled)
		return db.query(sql.replace(/\s+FORMAT\s+\w+\s*$/, "\nFORMAT JSONEachRow"))
	}

	// Each query must see org A (or the check is vacuous) and must never see org B.
	const expectOnlyOrgA = (output: string, marker: string) => {
		expect(output).toContain(`"a-${marker}`)
		expect(output).not.toContain(`"b-`)
		expect(output).not.toContain(ORG_B)
	}

	test("service overview, across the raw and hourly tiers", async () => {
		const output = await runAsOrgA(CH.compile(CH.serviceOverviewQuery({}), { orgId: ORG_A, ...window }))
		expectOnlyOrgA(output, "api")
		const spanCounts = decodeOverview(output).map((row) => [row.serviceName, Number(row.spanCount)])
		expect(spanCounts.sort()).toEqual([
			["a-api", 3],
			["a-front", 3],
		])
	})

	test("service usage", async () => {
		const output = await runAsOrgA(CH.compile(CH.serviceUsageQuery({}), { orgId: ORG_A, ...window }))
		expectOnlyOrgA(output, "api")
	})

	test("alert check group totals", async () => {
		const since = DateTime.makeUnsafe(currentHourMs - 5 * HOUR_MS)
		const until = DateTime.makeUnsafe(nowMs)
		const output = await runAsOrgA(
			CH.compile(CH.alertCheckGroupTotalsQuery({ since, until }), {
				orgId: ORG_A,
				ruleId: RULE_ID,
				since,
				until,
			}),
		)
		expectOnlyOrgA(output, "group")
	})

	test("service map address resolutions, on both join sides", async () => {
		const output = await runAsOrgA(
			CH.serviceMapResolutionsRollupSQL({
				orgId: ORG_A,
				hourStart: seconds(currentHourMs - 3 * HOUR_MS),
				hourEnd: seconds(currentHourMs - 2 * HOUR_MS),
			}),
		)
		expectOnlyOrgA(output, "api")
	})
})
