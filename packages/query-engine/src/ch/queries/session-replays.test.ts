import { describe, expect, it } from "vitest"
import { compileCH } from "@maple-dev/clickhouse-builder"
import {
	getSessionReplayQuery,
	sessionReplayEventsQuery,
	sessionTraceSummariesQuery,
} from "./session-replays"

const baseParams = { orgId: "org_1" }
const sessionParams = { orgId: "org_1", sessionId: "sess_1" }
const WINDOW = { startTime: "2026-06-24 04:00:00", endTime: "2026-06-25 06:00:00" }

// ---------------------------------------------------------------------------
// sessionTraceSummariesQuery
//
// One bar per correlated trace on the session replay timeline. The root span's
// kind + attributes ride along so the UI can render the canonical HTTP label
// (`POST /api/foo`) instead of the raw span name (e.g. `HTTP POST`).
// ---------------------------------------------------------------------------

describe("sessionTraceSummariesQuery", () => {
	it("projects the root span kind + attributes for HTTP label formatting", () => {
		const q = sessionTraceSummariesQuery({ traceIds: ["abc123"] })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM trace_detail_spans")
		expect(sql).toContain("AS rootSpanName")
		expect(sql).toContain("anyIf(SpanKind, ParentSpanId = '') AS rootSpanKind")
		expect(sql).toContain("anyIf(toJSONString(SpanAttributes), ParentSpanId = '') AS rootSpanAttributes")
		expect(sql).toContain("GROUP BY traceId")
		expect(sql).toContain("FORMAT JSON")
	})

	it("scopes to org and the requested trace ids", () => {
		const q = sessionTraceSummariesQuery({ traceIds: ["t1", "t2"] })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("OrgId = 'org_1'")
		expect(sql).toContain("TraceId IN ('t1', 't2')")
	})

	// The table is PARTITION BY toDate(Timestamp); the session window prunes the
	// daily partitions an unbounded TraceId-IN scan would otherwise touch.
	it("adds the session time window as a partition-pruning predicate when provided", () => {
		const q = sessionTraceSummariesQuery({ traceIds: ["t1"], ...WINDOW })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("Timestamp >= '2026-06-24 04:00:00'")
		expect(sql).toContain("Timestamp <= '2026-06-25 06:00:00'")
	})

	it("omits the time window when absent (deep-link path, unchanged full scan)", () => {
		const q = sessionTraceSummariesQuery({ traceIds: ["t1"] })
		const { sql } = compileCH(q, baseParams)
		expect(sql).not.toContain("Timestamp >=")
		expect(sql).not.toContain("Timestamp <=")
	})
})

describe("sessionReplayEventsQuery", () => {
	it("adds the session time window as a partition-pruning predicate when provided", () => {
		const q = sessionReplayEventsQuery(WINDOW)
		const { sql } = compileCH(q, sessionParams)
		expect(sql).toContain("FROM session_replay_events")
		expect(sql).toContain("Timestamp >= '2026-06-24 04:00:00'")
		expect(sql).toContain("Timestamp <= '2026-06-25 06:00:00'")
	})

	it("omits the time window when absent (full scan)", () => {
		const q = sessionReplayEventsQuery()
		const { sql } = compileCH(q, sessionParams)
		expect(sql).not.toContain("Timestamp >=")
	})
})

describe("getSessionReplayQuery", () => {
	// session_replays is PARTITION BY toDate(StartTime); StartTime is version-
	// invariant so the window is safe alongside the ORDER BY Version DESC dedup.
	it("adds the session time window on StartTime when provided", () => {
		const q = getSessionReplayQuery(WINDOW)
		const { sql } = compileCH(q, sessionParams)
		expect(sql).toContain("StartTime >= '2026-06-24 04:00:00'")
		expect(sql).toContain("StartTime <= '2026-06-25 06:00:00'")
	})

	it("omits the time window when absent (full scan)", () => {
		const q = getSessionReplayQuery()
		const { sql } = compileCH(q, sessionParams)
		expect(sql).not.toContain("StartTime >=")
	})
})
