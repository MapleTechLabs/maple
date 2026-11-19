import { DB_QUERY_LABEL_SQL } from "@maple/domain/tinybird/db-query-shape-sql"
import { describe, expect, it } from "vitest"
import { SQL_TABLE_RE, SQL_VERB_RE, redactSqlLiterals, summarizeSql } from "./fingerprint"
import { String as Str } from "effect"

/**
 * Statements pulled verbatim from production `Database.execute` spans
 * (`db.query.text`, 2026-08-03). These are what the Postgres client span will
 * actually summarize, so they are the corpus that matters.
 */
const PRODUCTION_STATEMENTS: ReadonlyArray<readonly [sql: string, summary: string]> = [
	[
		`update "alert_rule_states" set "last_error" = $1, "updated_at" = $2 where ("alert_rule_states"."org_id" = $3)`,
		"UPDATE alert_rule_states",
	],
	[
		`select "org_id", "enabled", "max_runs_per_day" from "ai_triage_settings" where "ai_triage_settings"."org_id" = $1 limit $2`,
		"SELECT ai_triage_settings",
	],
	[
		`delete from "alert_rule_states" where ("alert_rule_states"."org_id" = $1 and "alert_rule_states"."rule_id" = $2)`,
		"DELETE alert_rule_states",
	],
	[
		`insert into "error_incidents" ("id", "org_id", "issue_id") values ($1, $2, $3)`,
		"INSERT error_incidents",
	],
	[
		`insert into "alert_rule_claims" ("rule_id", "org_id") values ($1, $2) on conflict ("rule_id") do update set "last_scheduled_at" = $3`,
		"INSERT alert_rule_claims",
	],
	// A join picks the FROM table, not the joined one — the first clause wins.
	[
		`select distinct "alert_incidents"."rule_id" from "alert_incidents" inner join "alert_rules" on "alert_incidents"."rule_id" = "alert_rules"."id"`,
		"SELECT alert_incidents",
	],
	[`select distinct "org_id" from "org_ingest_keys"`, "SELECT org_ingest_keys"],
	// selectDistinctOrgIds' loose index scan: the leading verb is WITH.
	[
		`\n\t\twith recursive t as (\n\t\t\t(\n\t\t\t\tselect "error_issues"."org_id" as org_id\n\t\t\t\tfrom "error_issues"\n\t\t\t)\n\t\t)`,
		"WITH error_issues",
	],
	// A transaction lands as several statements joined by ";\n"; the first wins.
	[`begin;\nupdate "error_issues" set "error_label" = $1;\ncommit`, "BEGIN error_issues"],
]

describe("summarizeSql", () => {
	it.each(PRODUCTION_STATEMENTS)("summarizes %#", (sql, summary) => {
		expect(summarizeSql(sql).summary).toBe(summary)
	})

	it("splits the summary into its OTEL parts", () => {
		expect(summarizeSql(`select "id" from "actors" where "actors"."org_id" = $1`)).toEqual({
			operation: "SELECT",
			collection: "actors",
			summary: "SELECT actors",
		})
	})

	it("omits the collection when no table clause is present", () => {
		expect(summarizeSql("commit")).toEqual({
			operation: "COMMIT",
			collection: "",
			summary: "COMMIT",
		})
	})

	it("returns empty parts for empty SQL", () => {
		expect(summarizeSql("")).toEqual({ operation: "", collection: "", summary: "" })
	})

	it("does not mistake a column ending in `from` for a FROM clause", () => {
		// `"copied_from"` is followed by `"`, not whitespace — the read-side regex
		// requires `\s+` after the keyword, and so must this one.
		expect(summarizeSql(`select "copied_from", "id" from "actors"`).collection).toBe("actors")
	})
})

/**
 * The read side derives this same label from raw statement text when
 * `db.query.summary` is absent (precedence 3 of `DB_QUERY_LABEL_SQL`), and
 * prefers the emitted summary (precedence 1) once we start sending it. If the
 * two derivations drift, every existing shape in
 * `service_map_db_query_shapes_hourly` forks into a duplicate at the cutover —
 * so pin the patterns to the ones embedded in the ClickHouse fragment.
 */
describe("summarizeSql / ClickHouse parity", () => {
	/** A JS regex source as it appears inside a ClickHouse string literal (CH halves `\\` for RE2). */
	const asClickHouseLiteral = (re: RegExp) => Str.replaceAll("\\", "\\\\")(re.source)

	it("uses the same verb pattern as derivedStatementSummarySql", () => {
		expect(DB_QUERY_LABEL_SQL).toContain(asClickHouseLiteral(SQL_VERB_RE))
	})

	it("uses the same table pattern as derivedStatementSummarySql", () => {
		expect(DB_QUERY_LABEL_SQL).toContain(`(?i)${asClickHouseLiteral(SQL_TABLE_RE)}`)
	})
})

describe("redactSqlLiterals", () => {
	it("replaces strings, escaped quotes included, and numbers, and keeps identifiers", () => {
		expect(
			redactSqlLiterals(
				"SELECT count() FROM traces_v2 WHERE Name = 'O\\'Brien' AND Note = 'it''s' AND Ms > 1.5e3 AND Id IN (7, 8)",
			),
		).toBe("SELECT count() FROM traces_v2 WHERE Name = ? AND Note = ? AND Ms > ? AND Id IN (?, ?)")
	})

	it("reads a quote in a comment or a quoted identifier as no string", () => {
		expect(
			redactSqlLiterals(
				"SELECT 1 -- don't\nFROM t /* it's */ WHERE \"it's\" = 'a@b.c' AND `x'y` = 'secret'",
			),
		).toBe("SELECT ? --\nFROM t /* */ WHERE \"it's\" = ? AND `x'y` = ?")
	})

	it("redacts an unclosed string to the end, a trailing backslash included", () => {
		expect(redactSqlLiterals("WHERE e = 'a@b.c")).toBe("WHERE e = ?")
		expect(redactSqlLiterals("WHERE e = 'a@b.c\\")).toBe("WHERE e = ?")
	})

	it("leaves no value behind in the other comment, string and number forms the server reads", () => {
		const cases: ReadonlyArray<readonly [string, string]> = [
			["SELECT 1 # alice@example.com", "SELECT ? #"],
			["SELECT 1 /* outer /* inner */ alice@example.com */ FROM t", "SELECT ? /* */ FROM t"],
			["WHERE UserId = 0xDEADBEEF OR b = 0b1011", "WHERE UserId = ? OR b = ?"],
			["SELECT $tag$alice@example.com$tag$, $$x$$", "SELECT ?, ?"],
			["SELECT `a\\`'b` FROM t WHERE e = 'alice@example.com'", "SELECT `a\\`'b` FROM t WHERE e = ?"],
			["SELECT 1 // alice@example.com\nFROM t", "SELECT ? //\nFROM t"],
			["SELECT /* a */ 'b*/ alice@example.com'", "SELECT /* */ ?"],
			["SELECT $tag$x$TAG$alice@example.com$tag$ AS v", "SELECT ? AS v"],
			["SELECT 123_456, 1.5e-3, 0x1E-2 FROM traces_v2", "SELECT ?, ?, ?-? FROM traces_v2"],
			["SELECT a / b FROM t", "SELECT a / b FROM t"],
			["SELECT a$t$ FROM t WHERE e = 'alice@example.com'", "SELECT a$t$ FROM t WHERE e = ?"],
		]
		for (const [sql, redacted] of cases) {
			expect(redactSqlLiterals(sql)).toBe(redacted)
		}
	})
})
