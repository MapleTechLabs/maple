/**
 * One-shot generator for the error_events_mv label-refresh migration (0003).
 *
 * Pulls the *verbatim* current `error_events_mv` CREATE statement out of the
 * generated snapshot so the frozen migration body can't drift from / mis-escape
 * the real DDL. Run once: `bun run packages/domain/scripts/gen-error-label-migration.ts`
 */
import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { latestSnapshotStatements } from "../src/generated/clickhouse-schema"

const mvCreate = latestSnapshotStatements.find((s) =>
	s.includes("CREATE MATERIALIZED VIEW IF NOT EXISTS error_events_mv"),
)
if (!mvCreate) throw new Error("error_events_mv CREATE not found in snapshot")

// Self-contained label expression over error_events' OWN columns (ExceptionType,
// StatusMessage) — recomputes ErrorLabel for historical rows WITHOUT touching
// FingerprintHash. Mirrors `_errorLabel` in the MV: exception type wins, else the
// StatusMessage-derived label.
const labelExpr = `if(ExceptionType != '', ExceptionType, multiIf(StatusMessage = '', 'Unknown Error', position(StatusMessage, '{ readonly') = 1 OR position(StatusMessage, '└─') > 0, if(extract(StatusMessage, 'readonly (\\\\w+)') != '', concat('Schema parse error: ', extract(StatusMessage, 'readonly (\\\\w+)')), 'Schema parse error'), (isValidJSON(StatusMessage) AND JSONType(StatusMessage) = 'Object') OR position(StatusMessage, '[') = 1, multiIf(JSONExtractString(StatusMessage, 'title') != '', JSONExtractString(StatusMessage, 'title'), JSONExtractString(StatusMessage, 'message') != '', JSONExtractString(StatusMessage, 'message'), JSONExtractString(StatusMessage, 'error') != '', JSONExtractString(StatusMessage, 'error'), JSONExtractString(StatusMessage, '_tag') != '', JSONExtractString(StatusMessage, '_tag'), JSONExtractString(StatusMessage, 'reason') != '', JSONExtractString(StatusMessage, 'reason'), JSONExtractString(StatusMessage, 'name') != '', JSONExtractString(StatusMessage, 'name'), JSONExtractString(StatusMessage, 'type') != '', extract(JSONExtractString(StatusMessage, 'type'), '([^/]+)$'), 'JSON error'), left(StatusMessage, multiIf(position(StatusMessage, ': ') > 3, toInt64(position(StatusMessage, ': ')) - 1, position(StatusMessage, ' (') > 3, toInt64(position(StatusMessage, ' (')) - 1, position(StatusMessage, '\\n') > 3, toInt64(position(StatusMessage, '\\n')) - 1, least(toInt64(length(StatusMessage)), 150)))))`

const statements = [
	// Air-gapped CHs that never got the applySchema ADD COLUMN still need it.
	"ALTER TABLE error_events ADD COLUMN IF NOT EXISTS ErrorLabel String DEFAULT ''",
	// The MV body is frozen at creation; recreate it so new rows compute ErrorLabel
	// + the JSON-aware fingerprint. TO-target MV: dropping it does NOT drop stored data.
	"DROP VIEW IF EXISTS error_events_mv",
	mvCreate,
	// Backfill labels for existing rows (no re-hash; FingerprintHash untouched).
	`ALTER TABLE error_events UPDATE ErrorLabel = ${labelExpr} WHERE ErrorLabel = ''`,
]

const body = `/**
 * Migration 0003 — error_events label + JSON-aware fingerprint refresh.
 *
 * \`error_events\` gained an \`ErrorLabel\` column and \`error_events_mv\` gained a
 * JSON-aware fingerprint + value-aware label. A materialized view's SELECT is
 * frozen at creation, so adding the column alone left every row's ErrorLabel
 * empty. This drops + recreates the MV with the new body and backfills labels
 * for existing rows (recomputed from each row's StatusMessage / ExceptionType;
 * FingerprintHash is left untouched, so existing issues do not re-bucket).
 *
 * Generated from the snapshot by scripts/gen-error-label-migration.ts.
 */
export const migration_0003_error_events_label = {
	version: 3,
	description: "Recreate error_events_mv (JSON-aware fingerprint + ErrorLabel) and backfill labels",
	statements: ${JSON.stringify(statements, null, 2).replace(/\n/g, "\n\t")},
} as const
`

const out = fileURLToPath(new URL("../src/clickhouse/migrations/0003_error_events_label.ts", import.meta.url))
writeFileSync(out, body)
console.log("wrote", out)
