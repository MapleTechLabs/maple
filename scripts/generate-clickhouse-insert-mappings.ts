import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { emitJsonPathSpec } from "../packages/domain/src/clickhouse/ddl-emitter"
import { buildTinybirdProjectManifest } from "../packages/domain/src/tinybird/project-manifest"

// Datasources the local OTLP ingest path actually writes. session_* (replay
// ingest) and alert_checks (alerting engine) are written by subsystems the
// lightweight local binary does not run, so they are out of scope here.
const OTLP_DATASOURCES = [
	"traces",
	"logs",
	"metrics_sum",
	"metrics_gauge",
	"metrics_histogram",
	"metrics_exponential_histogram",
] as const

// Replaced by the Rust binary with the pinned, escaped org-id string literal.
const ORG_PLACEHOLDER = "__ORG__"

const outputPath = fileURLToPath(
	new URL("../apps/ingest/schema/local-inserts.json", import.meta.url),
)
const checkMode = process.argv.includes("--check")

interface DatasourceMapping {
	readonly table: string
	readonly columns: ReadonlyArray<string>
	readonly selects: ReadonlyArray<string>
	readonly inputSchema: string
}

const manifest = await buildTinybirdProjectManifest()
const byName = new Map(manifest.datasources.map((ds) => [ds.name, ds]))

const datasources: Record<string, DatasourceMapping> = {}
for (const name of OTLP_DATASOURCES) {
	const ds = byName.get(name)
	if (!ds) {
		throw new Error(`OTLP datasource "${name}" not found in Tinybird manifest`)
	}
	datasources[name] = buildMapping(name, emitJsonPathSpec(ds))
}

const rendered = `${JSON.stringify(
	{ projectRevision: manifest.projectRevision, orgPlaceholder: ORG_PLACEHOLDER, datasources },
	null,
	2,
)}\n`

let existing = ""
try {
	existing = readFileSync(outputPath, "utf8")
} catch {
	existing = ""
}

if (checkMode) {
	if (existing !== rendered) {
		console.error("local-inserts.json is out of date. Run `bun run clickhouse:schema`.")
		process.exit(1)
	}
	console.log(
		`local-inserts.json is up to date (${manifest.projectRevision}, ${OTLP_DATASOURCES.length} datasources).`,
	)
} else {
	mkdirSync(dirname(outputPath), { recursive: true })
	writeFileSync(outputPath, rendered)
	console.log(
		`Wrote local-inserts.json (${manifest.projectRevision}, ${OTLP_DATASOURCES.length} datasources) to ${outputPath}.`,
	)
}

function buildMapping(
	table: string,
	spec: ReadonlyArray<{ column: string; type: string; jsonPath: string | null }>,
): DatasourceMapping {
	const columns: string[] = []
	const selects: string[] = []
	const inputFields: string[] = []
	// Two columns can map to the same JSON leaf (e.g. logs `Timestamp` and
	// `TimestampTime` both read `$.timestamp`). The `format()` structure must
	// declare each leaf once — but the SELECT may reference it for several
	// target columns. Track the first type seen per leaf and skip duplicates in
	// the input schema only.
	const seenLeaves = new Set<string>()

	for (const { column, type, jsonPath } of spec) {
		if (column === "OrgId") {
			// Single-tenant local mode pins OrgId; never extracted from JSON.
			columns.push(column)
			selects.push(ORG_PLACEHOLDER)
			continue
		}
		if (jsonPath === null || jsonPath === `$.${column}`) {
			// No JSON path, or a PascalCase-identity path (a computed DEFAULT/
			// MATERIALIZED column the gateway never emits, e.g. SampleRate,
			// IsEntryPoint). Omit so the table's DEFAULT expression computes it.
			continue
		}
		const leaf = jsonLeaf(table, column, jsonPath)
		columns.push(column)
		selects.push(leaf)
		if (!seenLeaves.has(leaf)) {
			seenLeaves.add(leaf)
			inputFields.push(`${leaf} ${type}`)
		}
	}

	return { table, columns, selects, inputSchema: inputFields.join(", ") }
}

function jsonLeaf(table: string, column: string, jsonPath: string): string {
	// Accept `$.field` and `$.field[:]` (array). Anything else is a nested or
	// expression path we don't auto-map for local ingest.
	const match = /^\$\.([A-Za-z_][A-Za-z0-9_]*)(\[:\])?$/.exec(jsonPath)
	if (!match) {
		throw new Error(
			`Unsupported jsonPath "${jsonPath}" for ${table}.${column}; generator only handles top-level $.field and $.field[:] paths.`,
		)
	}
	return match[1] as string
}
