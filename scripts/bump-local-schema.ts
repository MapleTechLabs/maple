/**
 * Scaffold a local-store schema version bump.
 *
 * Everything the append-only gate demands except the DDL itself is a pure
 * function of one integer: the snapshot copy (the history derives its identity
 * from it), the version constant, two edit sites in `local-schema-history.ts`,
 * and a new row in the step table. This script writes all of them, then leaves
 * the row's operations to a human, which is the only part that was ever real work.
 *
 * Run it AFTER `bun run clickhouse:schema` has regenerated the local DDL, so
 * `schema/local-schema.sql` already holds the schema being bumped to.
 *
 *   bun run local-schema:bump <slug> [--description "..."]
 *   bun run local-schema:bump --control
 */
import { Schema, String as Str } from "effect"
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { schemaDigest, schemaFingerprint } from "../packages/local-server/src/store-version"

// The schema, its frozen snapshots and the history derived from them live in
// @maple/local-server; the migration steps that read them stay in the CLI.
const SERVER_DIR = "packages/local-server/src"
const STEPS_FILE = "apps/cli/src/server/local-store-migrations/steps.ts"
const SCHEMA_DIR = `${SERVER_DIR}/schema`
const SNAPSHOT_DIR = `${SCHEMA_DIR}/history`

// The annotation is on the variable, not just the arrow: TypeScript narrows
// control flow through a `never`-returning const only when it is declared this
// way, which is what lets the guards below act as assertions.
const fail: (message: string) => never = (message) => {
	console.error(`\n${message}\n`)
	process.exit(1)
	throw new Error(message)
}

const read = (path: string): string => readFileSync(path, "utf8")

interface PlannedWrite {
	readonly path: string
	readonly content: string
}

/**
 * Every edit is anchored, and nothing reaches disk until all of them have
 * matched. A bump that half-applied was worse than one that refused: the
 * `existsSync` guards then rejected the retry, so the developer had to unpick
 * a partial scaffold by hand before trying again.
 */
const plan = (path: string, edits: ReadonlyArray<readonly [string, string]>): PlannedWrite => {
	let source = read(path)
	for (const [needle, replacement] of edits) {
		const matches = Str.split(needle)(source).length - 1
		if (matches !== 1)
			fail(
				`${path}: anchor matched ${matches} times, expected exactly one, so the bump was not applied:\n  ${needle}`,
			)
		source = Str.replace(needle, replacement)(source)
	}
	return { path, content: source }
}

const pad = (version: number): string => Str.padStart(4, "0")(String(version))

// ---------------------------------------------------------------------------
// Arguments and current state
// ---------------------------------------------------------------------------

if (process.argv.includes("--control")) {
	await import("./bump-local-control-schema")
	process.exit(0)
}

const args = process.argv.slice(2)
const encodeJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.String))
const descriptionIndex = args.findIndex((arg) => arg === "--description")
const description = descriptionIndex === -1 ? undefined : args[descriptionIndex + 1]
// Guard the -1 case: with no `--description`, `descriptionIndex + 1` is 0, which
// would skip the slug itself.
const slug = args.find(
	(arg, index) =>
		!Str.startsWith("--")(arg) && !(descriptionIndex !== -1 && index === descriptionIndex + 1),
)

if (!slug || !/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(slug))
	fail(
		'usage: bun run local-schema:bump <kebab-case-slug> [--description "..."]\n\ne.g. bun run local-schema:bump service-operations-discriminators',
	)

const versionSource = read(`${SERVER_DIR}/local-schema-version.ts`)
const versionMatch = /export const LOCAL_SCHEMA_VERSION = (\d+) as const/.exec(versionSource)
if (!versionMatch) fail("could not read LOCAL_SCHEMA_VERSION")
const from = Number(versionMatch[1])
const to = from + 1

const snapshotPath = `${SNAPSHOT_DIR}/local-schema-v${to}.sql`
if (existsSync(snapshotPath)) fail(`${snapshotPath} already exists; v${to} looks already bumped`)

// The identity is computed from the generated DDL directly rather than through
// `local-schema-history.ts`, which cannot even be imported until the v{to}
// snapshot it statically imports exists.
const currentSql = read(`${SCHEMA_DIR}/local-schema.sql`)
const fingerprint = schemaFingerprint(currentSql)

if (schemaDigest(currentSql) === schemaDigest(read(`${SNAPSHOT_DIR}/local-schema-v${from}.sql`)))
	fail(
		`the generated schema still hashes to the v${from} snapshot (${fingerprint}).\nEdit the schema and run \`bun run clickhouse:schema\` before bumping.`,
	)

// ---------------------------------------------------------------------------
// The new row in the step table. Only the operations need a human: the clone,
// the v{to} bootstrap and the raw-row verification are the executor's.
// ---------------------------------------------------------------------------

// A row's id and versions follow from its position, so the new row only names its slug.
const moduleId = `local-${pad(from)}-to-${pad(to)}-${slug}`

const STEPS_ANCHOR = "\t// local-schema:bump appends the next step above this line.\n"
const newRow = `\t{
\t\t// TODO(v${from} -> v${to}): what changes, and what is NOT backfilled. Fill beforeBootstrap
\t\t// with the ADD COLUMN / view drops an IF NOT EXISTS bootstrap cannot do, then the
\t\t// plan line and dispositions. The v${to} physical verify fails an unfinished row.
\t\tslug: "${slug}",
\t\tdescription: ${encodeJsonString(description ?? `TODO(v${from} -> v${to}): what this edge does, in one line`)},
\t\tclonedBefore: "any DDL runs",
\t\tbeforeBootstrap: [],
\t\tplan: [["TODO-v${to}-change", "TODO(v${from} -> v${to}): what the v${to} bootstrap changes"]],
\t\tdispositions: [],
\t},
`

// ---------------------------------------------------------------------------
// The mechanical edits
// ---------------------------------------------------------------------------

const plannedVersion: PlannedWrite = plan(`${SERVER_DIR}/local-schema-version.ts`, [
	[
		`export const LOCAL_SCHEMA_VERSION = ${from} as const`,
		`export const LOCAL_SCHEMA_VERSION = ${to} as const`,
	],
])

const plannedSnapshots: PlannedWrite = plan(`${SERVER_DIR}/local-schema-history.ts`, [
	[
		`import schemaV${from}Sql from "./schema/history/local-schema-v${from}.sql" with { type: "text" }`,
		`import schemaV${from}Sql from "./schema/history/local-schema-v${from}.sql" with { type: "text" }\nimport schemaV${to}Sql from "./schema/history/local-schema-v${to}.sql" with { type: "text" }`,
	],
	[`\tschemaV${from}Sql,\n]`, `\tschemaV${from}Sql,\n\tschemaV${to}Sql,\n]`],
])

const plannedSteps: PlannedWrite = plan(STEPS_FILE, [[STEPS_ANCHOR, `${newRow}${STEPS_ANCHOR}`]])

// Every anchor matched, so the bump is now committed to disk in one go.
const writes: ReadonlyArray<PlannedWrite> = [
	// The retained snapshot is the generated DDL, verbatim.
	{ path: snapshotPath, content: currentSql },
	plannedVersion,
	plannedSnapshots,
	plannedSteps,
]
for (const write of writes) writeFileSync(write.path, write.content)

try {
	execFileSync("git", ["add", "--intent-to-add", snapshotPath], { stdio: "ignore" })
} catch {
	// A bump outside a git checkout is still a valid bump.
}

console.log(`bumped local schema v${from} -> v${to} (${fingerprint})

  ${snapshotPath}
  ${STEPS_FILE}  <- fill in the ${moduleId} row

edited: local-schema-version.ts, local-schema-history.ts

next:
  1. write the row's beforeBootstrap operations, plan line and dispositions (see its TODO)
  2. bun run clickhouse:schema:check
  3. bun run --cwd apps/cli test
`)
