/**
 * Scaffold a local-store schema version bump.
 *
 * Everything the append-only gate demands except the DDL itself is a pure
 * function of one integer: the snapshot copy, the version constant, three edit
 * sites in `schema-identity.ts`, the history entry's four hashes, a new row in
 * the step table, and the pinned literals in both the bun test and the native
 * probe. This script writes all of them, then leaves the row's operations to a
 * human, which is the only part that was ever real work.
 *
 * Run it AFTER `bun run clickhouse:schema` has regenerated the local DDL, so
 * `schema/local-schema.sql` already holds the schema being bumped to.
 *
 *   bun run local-schema:bump <slug> [--description "..."]
 *   bun run local-schema:bump --control
 */
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { buildLocalSchemaManifest } from "../apps/cli/src/server/schema-manifest"
import { schemaDigest, schemaFingerprint } from "../apps/cli/src/server/store-version"

const SERVER_DIR = "apps/cli/src/server"
const STEPS_FILE = `${SERVER_DIR}/local-store-migrations/steps.ts`
const SCHEMA_DIR = `${SERVER_DIR}/schema`
const TEST_FILE = "apps/cli/test/local-store-migrations.test.ts"
const NATIVE_PROBE = "apps/cli/test/native-local-store-migration.sh"

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
const plan = (path: string, edits: ReadonlyArray<readonly [string | RegExp, string]>): PlannedWrite => {
	let source = read(path)
	for (const [needle, replacement] of edits) {
		const matches =
			typeof needle === "string"
				? source.split(needle).length - 1
				: [...source.matchAll(new RegExp(needle.source, `${needle.flags.replace("g", "")}g`))].length
		if (matches === 0) fail(`${path}: anchor did not match, so the bump was not applied:\n  ${needle}`)
		if (typeof needle === "string" && matches > 1)
			fail(`${path}: anchor matched ${matches} times, expected exactly one:\n  ${needle}`)
		source =
			typeof needle === "string"
				? source.replace(needle, replacement)
				: source.replace(new RegExp(needle.source, `${needle.flags.replace("g", "")}g`), replacement)
	}
	return { path, content: source }
}

const pad = (version: number): string => String(version).padStart(4, "0")

// ---------------------------------------------------------------------------
// Arguments and current state
// ---------------------------------------------------------------------------

if (process.argv.includes("--control")) {
	await import("./bump-local-control-schema")
	process.exit(0)
}

const args = process.argv.slice(2)
const descriptionIndex = args.findIndex((arg) => arg === "--description")
const description = descriptionIndex === -1 ? undefined : args[descriptionIndex + 1]
// Guard the -1 case: with no `--description`, `descriptionIndex + 1` is 0, which
// would skip the slug itself.
const slug = args.find(
	(arg, index) => !arg.startsWith("--") && !(descriptionIndex !== -1 && index === descriptionIndex + 1),
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

const snapshotPath = `${SCHEMA_DIR}/local-schema-v${to}.sql`
if (existsSync(snapshotPath)) fail(`${snapshotPath} already exists; v${to} looks already bumped`)

// The identity is computed from the generated DDL directly rather than through
// `schema-identity.ts`, which cannot even be imported until the v{to} snapshot
// it statically imports exists.
const currentSql = read(`${SCHEMA_DIR}/local-schema.sql`)
const identity = {
	version: to,
	fingerprint: schemaFingerprint(currentSql),
	digest: schemaDigest(currentSql),
	manifestDigest: buildLocalSchemaManifest(currentSql).digest,
	projectRevision: (() => {
		const source = read(`${SERVER_DIR}/schema-identity.ts`)
		const match = /export const CURRENT_SCHEMA_PROJECT_REVISION =\s*"([0-9a-f]{64})"/.exec(source)
		if (!match) fail("could not read CURRENT_SCHEMA_PROJECT_REVISION")
		return match[1]
	})(),
}

const historySource = read(`${SERVER_DIR}/local-schema-history.ts`)
if (historySource.includes(`fingerprint: "${identity.fingerprint}"`))
	fail(
		`the generated schema still hashes to an identity already in the history (${identity.fingerprint}).\nEdit the schema and run \`bun run clickhouse:schema\` before bumping.`,
	)

// ---------------------------------------------------------------------------
// The new row in the step table. Only the operations need a human: the clone,
// the v{to} bootstrap and the raw-row verification are the executor's.
// ---------------------------------------------------------------------------

const stepsSource = read(STEPS_FILE)
const previousModuleId = new RegExp(`id: "(local-${pad(from - 1)}-to-${pad(from)}-[a-z0-9-]+)"`).exec(
	stepsSource,
)?.[1]
if (!previousModuleId) fail(`no v${from - 1} -> v${from} row in ${STEPS_FILE} to follow`)
const moduleId = `local-${pad(from)}-to-${pad(to)}-${slug}`
if (stepsSource.includes(`"${moduleId}"`)) fail(`${moduleId} is already in ${STEPS_FILE}`)

const STEPS_ANCHOR = "\t// local-schema:bump appends the next step above this line.\n"
const newRow = `\t{
\t\t// TODO(v${from} -> v${to}): what changes, and what is NOT backfilled. Fill beforeBootstrap
\t\t// with the ADD COLUMN / view drops an IF NOT EXISTS bootstrap cannot do, then the
\t\t// plan line and dispositions. The v${to} physical verify fails an unfinished row.
\t\tid: "${moduleId}",
\t\tfrom: ${from},
\t\tto: ${to},
\t\tdescription: ${JSON.stringify(description ?? `TODO(v${from} -> v${to}): what this edge does, in one line`)},
\t\tclonedBefore: "any DDL runs",
\t\tbeforeBootstrap: [],
\t\tplan: [["TODO-v${to}-change", "TODO(v${from} -> v${to}): what the v${to} bootstrap changes"]],
\t\tverifies: "Verify the v${to} physical schema and the retained raw telemetry counts",
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

const plannedIdentity: PlannedWrite = plan(`${SERVER_DIR}/schema-identity.ts`, [
	[
		`import schemaV${from}Sql from "./schema/local-schema-v${from}.sql" with { type: "text" }`,
		`import schemaV${from}Sql from "./schema/local-schema-v${from}.sql" with { type: "text" }\nimport schemaV${to}Sql from "./schema/local-schema-v${to}.sql" with { type: "text" }`,
	],
	[`\tschemaV${from}Sql,\n]`, `\tschemaV${from}Sql,\n\tschemaV${to}Sql,\n]`],
	// The test pins CURRENT_LOCAL_SCHEMA to this constant; steps look versions up by number.
	[
		`export const LOCAL_SCHEMA_V${from} = localSchemaIdentity(${from})`,
		`export const LOCAL_SCHEMA_V${from} = localSchemaIdentity(${from})\nexport const LOCAL_SCHEMA_V${to} = localSchemaIdentity(${to})`,
	],
])

// The control-schema history below it closes the same way, so the anchor includes its heading.
const HISTORY_ANCHOR = "] as const)\n\n/** Immutable SQLite control DDL identities"
const plannedHistory: PlannedWrite = plan(`${SERVER_DIR}/local-schema-history.ts`, [
	[
		HISTORY_ANCHOR,
		`\tObject.freeze({
		// TODO(v${to}): what changed, whether any part is rewritten or any row
		// moves, and what this edge does NOT backfill.
		//
		// projectRevision is carried forward deliberately: it is a hardcoded
		// constant that no longer tracks the generator's header, and the identity
		// this gate compares is the fingerprint/digest pair.
		version: ${identity.version},
		fingerprint: "${identity.fingerprint}",
		digest: "${identity.digest}",
		manifestDigest: "${identity.manifestDigest}",
		projectRevision: "${identity.projectRevision}",
	}),
${HISTORY_ANCHOR}`,
	],
])

const plannedSteps: PlannedWrite = plan(STEPS_FILE, [[STEPS_ANCHOR, `${newRow}${STEPS_ANCHOR}`]])

const plannedTest: PlannedWrite = plan(TEST_FILE, [
	[`\tLOCAL_SCHEMA_V${from},\n`, `\tLOCAL_SCHEMA_V${from},\n\tLOCAL_SCHEMA_V${to},\n`],
	[/matches the generated v\d+ revision/, `matches the generated v${to} revision`],
	[
		/expect\(SCHEMA_FINGERPRINT\)\.toBe\("[0-9a-f]+"\)/,
		`expect(SCHEMA_FINGERPRINT).toBe("${identity.fingerprint}")`,
	],
	[/expect\(SCHEMA_DIGEST\)\.toBe\("[0-9a-f]+"\)/, `expect(SCHEMA_DIGEST).toBe("${identity.digest}")`],
	[
		`expect(CURRENT_LOCAL_SCHEMA.version).toBe(${from})`,
		`expect(CURRENT_LOCAL_SCHEMA.version).toBe(${to})`,
	],
	[
		`expect(CURRENT_LOCAL_SCHEMA).toEqual(LOCAL_SCHEMA_V${from})`,
		`expect(CURRENT_LOCAL_SCHEMA).toEqual(LOCAL_SCHEMA_V${to})`,
	],
	// The future-store guard is pinned one past the tip on purpose.
	[
		`{ ...CURRENT_LOCAL_SCHEMA, version: ${to}, fingerprint: "future", digest: SCHEMA_DIGEST }`,
		`{ ...CURRENT_LOCAL_SCHEMA, version: ${to + 1}, fingerprint: "future", digest: SCHEMA_DIGEST }`,
	],
	// Every pinned chain list (both resolved chains and the table walk) ends at the previous tip.
	[new RegExp(`(\\t+)"${previousModuleId}",\\n`), `$1"${previousModuleId}",\n$1"${moduleId}",\n`],
])

const plannedProbe: PlannedWrite = plan(NATIVE_PROBE, [
	[
		/\.schemaVersion == \d+ and \.schema == "[0-9a-f]+"/,
		`.schemaVersion == ${to} and .schema == "${identity.fingerprint}"`,
	],
])

// Every anchor matched, so the bump is now committed to disk in one go.
const writes: ReadonlyArray<PlannedWrite> = [
	// The retained snapshot is the generated DDL, verbatim.
	{ path: snapshotPath, content: currentSql },
	plannedVersion,
	plannedIdentity,
	plannedHistory,
	plannedSteps,
	plannedTest,
	plannedProbe,
]
for (const write of writes) writeFileSync(write.path, write.content)

try {
	execFileSync("git", ["add", "--intent-to-add", snapshotPath], { stdio: "ignore" })
} catch {
	// A bump outside a git checkout is still a valid bump.
}

console.log(`bumped local schema v${from} -> v${to} (${identity.fingerprint})

  ${snapshotPath}
  ${STEPS_FILE}  <- fill in the ${moduleId} row

edited: local-schema-version.ts, schema-identity.ts, local-schema-history.ts,
        ${TEST_FILE}, ${NATIVE_PROBE}

next:
  1. write the row's beforeBootstrap operations, plan line and dispositions (see its TODO)
  2. bun run clickhouse:schema:check
  3. bun run --cwd apps/cli test
`)
