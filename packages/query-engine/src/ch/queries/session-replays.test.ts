import { describe, expect, it } from "vitest"
import { compileCH } from "@maple-dev/clickhouse-builder"
import { sessionTraceSummariesQuery } from "./session-replays"

const baseParams = { orgId: "org_1" }

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
})
