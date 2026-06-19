import { describe, expect, it } from "vitest"
import { compileCH, from } from "@maple-dev/clickhouse-builder"
import { migrations } from "@maple/domain/clickhouse"
import { traceListMvMv } from "@maple/domain/tinybird"
import { Traces } from "./ch/tables"
import { buildAttrFilterCondition, httpDisplaySpanName } from "./traces-shared"

// ---------------------------------------------------------------------------
// MV / migration parity guard
//
// The quick-filter fix works by mirroring, on the raw-`traces` filter path, the
// exact HTTP normalization that `trace_list_mv` applies at write time:
//   - the span-name display rewrite ("http.server GET" + route -> "GET /route")
//   - the old/new OTel semconv coalescing (http.method <-> http.request.method,
//     http.status_code <-> http.response.status_code)
//
// That same SQL is hand-written as a string literal in THREE places:
//   1. this package's `httpDisplaySpanName` / `buildAttrFilterCondition` (TS DSL)
//   2. the Tinybird MV `trace_list_mv_mv` (packages/domain materializations.ts)
//   3. the ClickHouse migration 0004 that recreates the same MV
//
// If any one drifts, the facet COUNT (from the MV) and the applied FILTER (from
// these helpers) disagree again — the exact "facets vs list-filter invariant"
// bug this fix closes. These tests pin the TS encoding to the downstream SQL so
// a future edit to one side without the others fails CI.
// ---------------------------------------------------------------------------

// Structural comparison: ignore whitespace and parentheses. The CH DSL emits a
// redundant outer paren around the `if(...)` condition that the hand-written MV
// SQL omits; that's cosmetic. Exact compiled SQL (including parens) is already
// asserted in ch.test.ts — here we only cross-check TS vs MV agreement.
const canon = (sql: string) => sql.replace(/[\s()]/g, "")

/** Compiled SQL for `httpDisplaySpanName(SpanName, http.route, url.path)`. */
function compiledDisplayRewrite(): string {
	const q = from(Traces).select(($) => ({
		Display: httpDisplaySpanName(
			$.SpanName,
			$.SpanAttributes.get("http.route"),
			$.SpanAttributes.get("url.path"),
		),
	}))
	const { sql } = compileCH(q, {})
	const m = sql.match(/SELECT([\s\S]*?)AS Display/)
	if (!m) throw new Error("could not extract display fragment from compiled SQL")
	return m[1].trim()
}

/** Compiled `if(map[old] != '', map[old], map[new])` coalesce for an attr key. */
function compiledCoalesce(key: string): string {
	const cond = buildAttrFilterCondition({ key, value: "X", mode: "equals" }, "SpanAttributes")
	const q = from(Traces)
		.select(($) => ({ K: $.SpanName }))
		.where(() => [cond])
	const { sql } = compileCH(q, {})
	const m = sql.match(/WHERE([\s\S]*?)= 'X'/)
	if (!m) throw new Error(`could not extract coalesce fragment for ${key}`)
	return m[1].trim()
}

const mvSql = (traceListMvMv as { options: { nodes: ReadonlyArray<{ sql: string }> } }).options.nodes[0]!.sql

// Collect every SQL string in a migration's statements — strings directly, plus
// any string field of a structured statement (e.g. a BackfillSpec's `select`),
// where the recreated-MV rewrite actually lives. Decoupled from field names.
const collectStrings = (v: unknown): ReadonlyArray<string> =>
	typeof v === "string"
		? [v]
		: v && typeof v === "object"
			? Object.values(v).flatMap(collectStrings)
			: []

const migration0004 = migrations.find((m) => m.version === 4)
if (!migration0004) throw new Error("migration version 4 not found")
const migration0004Sql = migration0004.statements.flatMap(collectStrings).join("\n")

describe("HTTP semconv parity with trace_list_mv", () => {
	const display = compiledDisplayRewrite()
	const methodCoalesce = compiledCoalesce("http.method")
	const statusCoalesce = compiledCoalesce("http.status_code")

	// Guard against a vacuous pass if extraction ever returns something trivial.
	it("extracts non-trivial fragments from the TS helpers", () => {
		expect(display).toContain("replaceOne(SpanName, 'http.server ', '')")
		expect(methodCoalesce).toContain("http.request.method")
		expect(statusCoalesce).toContain("http.response.status_code")
	})

	for (const [label, sql] of [
		["materializations.ts trace_list_mv_mv", mvSql],
		["migration 0004", migration0004Sql],
	] as const) {
		it(`${label}: span-name display rewrite matches httpDisplaySpanName`, () => {
			expect(canon(sql)).toContain(canon(display))
		})

		it(`${label}: http.method coalesce matches buildAttrFilterCondition`, () => {
			expect(canon(sql)).toContain(canon(methodCoalesce))
		})

		it(`${label}: http.status_code coalesce matches buildAttrFilterCondition`, () => {
			expect(canon(sql)).toContain(canon(statusCoalesce))
		})
	}
})
