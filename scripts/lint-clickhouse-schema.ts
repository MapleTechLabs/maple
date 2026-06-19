/**
 * Schema lint — fast post-`generate-clickhouse-schema` sanity checks.
 *
 * Catches the class of bugs we hit in production once already: a
 * `CREATE MATERIALIZED VIEW … TO <table>` whose target table isn't itself
 * created by any statement in the snapshot. ClickHouse accepts the MV at
 * CREATE time but every subsequent INSERT into the MV's source table fails
 * with `Code: 60. UNKNOWN_TABLE`, which can wedge an entire ingest pipeline.
 *
 * Wire this into `clickhouse:schema:check` so the next instance of that
 * bug fails CI instead of production.
 */
import { latestSnapshotStatements } from "../packages/domain/src/generated/clickhouse-schema"
import { parseEmittedStatement } from "../packages/domain/src/clickhouse/ddl-emitter"

interface Violation {
	readonly kind: string
	readonly message: string
}

const violations: Violation[] = []

const tables = new Set<string>()
const materializedViews: Array<{ readonly name: string; readonly target: string }> = []

for (const stmt of latestSnapshotStatements) {
	const parsed = parseEmittedStatement(stmt)
	if (parsed === null) {
		violations.push({
			kind: "unparseable_statement",
			message: `parseEmittedStatement returned null for: ${stmt.split("\n")[0]?.slice(0, 120)}`,
		})
		continue
	}
	if (parsed.kind === "table") {
		tables.add(parsed.name)
	} else if (parsed.kind === "materialized_view") {
		materializedViews.push({ name: parsed.name, target: parsed.target })
	}
}

// Rule: every MV's `TO` target must be a table the snapshot creates.
for (const mv of materializedViews) {
	if (!tables.has(mv.target)) {
		violations.push({
			kind: "orphan_materialized_view",
			message: `MV "${mv.name}" targets table "${mv.target}" but no CREATE TABLE for "${mv.target}" exists in the snapshot. Either add the missing table or drop the MV.`,
		})
	}
}

// Rule: no ICU-gated functions. `lowerUTF8`/`upperUTF8` are only available in
// ClickHouse builds with ICU (24.8+ gates them), and the libchdb embedded by
// local mode is built without it — a schema using them bootstraps fine on
// Tinybird but crashes every fresh `maple start` with UNKNOWN_FUNCTION.
// For ASCII inputs `lower`/`upper` are byte-identical; for genuinely non-ASCII
// needs, find an ICU-free formulation instead.
const ICU_GATED_FUNCTIONS = /\b(lowerUTF8|upperUTF8)\s*\(/
for (const stmt of latestSnapshotStatements) {
	const match = stmt.match(ICU_GATED_FUNCTIONS)
	if (match) {
		violations.push({
			kind: "icu_gated_function",
			message: `Statement uses ${match[1]}(), which is missing from local mode's non-ICU libchdb. Use ${match[1] === "upperUTF8" ? "upper" : "lower"}() (identical for ASCII) or an ICU-free formulation. Statement: ${stmt.split("\n")[0]?.slice(0, 120)}`,
		})
	}
}

if (violations.length === 0) {
	console.log(`ClickHouse schema lint: OK (${tables.size} tables, ${materializedViews.length} MVs).`)
	process.exit(0)
}

console.error(`ClickHouse schema lint: ${violations.length} violation(s):`)
for (const v of violations) {
	console.error(`  [${v.kind}] ${v.message}`)
}
process.exit(1)
