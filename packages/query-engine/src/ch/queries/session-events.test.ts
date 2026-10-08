import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect } from "effect"
import { compile, compileUnsafe } from "@maple-dev/effect-orm/clickhouse"
import { sessionActivityQuery, sessionTranscriptQuery, IDLE_GAP_THRESHOLD_MS } from "./session-events"
import { OrgId } from "@maple/domain"

const sessionParams = { orgId: OrgId.make("org_1"), sessionId: "sess_1" }
const WINDOW = {
	startTime: DateTime.makeUnsafe("2026-06-24T04:00:00Z"),
	endTime: DateTime.makeUnsafe("2026-06-25T06:00:00Z"),
}

// sessionActivityQuery
//
// Active/idle time from gaps between distilled events: a lagInFrame window
// measures each event's gap to its predecessor, then sumIf splits the gaps at
// the idle threshold. One row per session.

describe("sessionActivityQuery", () => {
	it("computes per-event gaps with a lagInFrame window ordered by Timestamp, Seq", () => {
		const { sql } = compileUnsafe(sessionActivityQuery(), sessionParams)
		expect(sql).toContain("FROM session_events")
		expect(sql).toContain(
			"lagInFrame(session_events.Timestamp, 1, session_events.Timestamp) OVER (PARTITION BY session_events.SessionId ORDER BY session_events.Timestamp ASC, session_events.Seq ASC ROWS BETWEEN 1 PRECEDING AND CURRENT ROW)",
		)
		// Nanosecond subtraction → milliseconds.
		expect(sql).toContain("toUnixTimestamp64Nano(session_events.Timestamp)")
		expect(sql).toContain("/ 1000000 AS gapMs")
	})

	it("splits gaps into active / idle at the idle threshold", () => {
		const { sql } = compileUnsafe(sessionActivityQuery(), sessionParams)
		expect(sql).toContain(
			`sumIf(g.gapMs, (g.gapMs > 0 AND g.gapMs <= ${IDLE_GAP_THRESHOLD_MS})) AS activeTimeMs`,
		)
		expect(sql).toContain(`sumIf(g.gapMs, g.gapMs > ${IDLE_GAP_THRESHOLD_MS}) AS idleTimeMs`)
		expect(sql).toContain("GROUP BY sessionId")
	})

	it("scopes to the org + session and returns a single row", () => {
		const { sql } = compileUnsafe(sessionActivityQuery(), sessionParams)
		expect(sql).toContain("OrgId = 'org_1'")
		expect(sql).toContain("SessionId = 'sess_1'")
		expect(sql).toContain("LIMIT 1")
		expect(sql).toContain("FORMAT JSON")
	})

	it("adds the session time window as a partition-pruning predicate when provided", () => {
		const { sql } = compileUnsafe(sessionActivityQuery(WINDOW), sessionParams)
		expect(sql).toContain("Timestamp >= '2026-06-24 04:00:00'")
		expect(sql).toContain("Timestamp <= '2026-06-25 06:00:00'")
	})

	it("omits the time window when absent (deep-link path, full scan)", () => {
		const { sql } = compileUnsafe(sessionActivityQuery(), sessionParams)
		expect(sql).not.toContain("Timestamp >=")
		expect(sql).not.toContain("Timestamp <=")
	})
})

describe("session transcript rows decode timestamps to DateTime.Utc", () => {
	it.effect("sessionTranscriptQuery", () =>
		Effect.gen(function* () {
			const compiled = yield* compile(sessionTranscriptQuery(), sessionParams)
			expect(compiled.rowSchemaSource).toBe("derived")
			const [row] = yield* compiled.decodeRows([
				{
					timestamp: "2026-06-24 04:00:00.123456789",
					seq: 1,
					type: "click",
					url: "/",
					traceId: "",
					level: "",
					message: "",
					targetSelector: "button",
					targetText: "Go",
					netMethod: "",
					netUrl: "",
					netStatus: 0,
					netDurationMs: 0,
					errorStack: "",
					attributes: "{}",
				},
			])
			expect(DateTime.formatIso(row!.timestamp)).toBe("2026-06-24T04:00:00.123Z")
		}),
	)
})
