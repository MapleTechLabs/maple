import { Schema, Array as Arr, String as Str } from "effect"
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import {
	LOCAL_CONTROL_SCHEMA_HISTORY,
	LOCAL_SCHEMA_HISTORY_TIP,
	localSchemaHistory,
	localSchemaIdentity,
} from "../packages/local-server/src/local-schema-history"
import { LOCAL_CONTROL_SCHEMA_VERSION } from "../packages/local-server/src/local-schema-version"
import { execFileSync } from "node:child_process"
import {
	CURRENT_LOCAL_SCHEMA,
	LOCAL_SCHEMA_MANIFEST,
	LOCAL_SCHEMA_MANIFEST_DIGEST,
	LOCAL_SCHEMA_VERSION,
} from "../packages/local-server/src/schema-identity"
import { resolveMigrationChain } from "../packages/local-server/src/local-store-migrations"

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const fail = (message: string): never => {
	console.error(message)
	process.exit(1)
	throw new Error(message)
}

// The history is derived from the frozen snapshots, so its tip is the newest
// snapshot, and the current schema must be exactly that snapshot.
const tip = localSchemaIdentity(LOCAL_SCHEMA_HISTORY_TIP)
if (
	tip.version !== CURRENT_LOCAL_SCHEMA.version ||
	tip.digest !== CURRENT_LOCAL_SCHEMA.digest ||
	tip.manifestDigest !== CURRENT_LOCAL_SCHEMA.manifestDigest ||
	tip.projectRevision !== CURRENT_LOCAL_SCHEMA.projectRevision
) {
	console.error(
		`current local schema v${LOCAL_SCHEMA_VERSION} (${LOCAL_SCHEMA_MANIFEST_DIGEST}) is not the newest snapshot v${tip.version} (${tip.manifestDigest}).`,
	)
	if (CURRENT_LOCAL_SCHEMA.version === tip.version)
		console.error(
			`\nThe schema changed without a version bump. Run \`bun run local-schema:bump <slug>\` to snapshot v${tip.version + 1} and scaffold its migration edge.`,
		)
	fail("snapshot a new versioned schema and register its migration edge before changing the schema")
}

const names = Arr.map(LOCAL_SCHEMA_MANIFEST.objects, (object) => object.name)
if (new Set(names).size !== names.length)
	fail("local structural schema manifest contains duplicate object names")

for (const entry of localSchemaHistory()) {
	try {
		resolveMigrationChain(
			{
				version: entry.version,
				fingerprint: entry.fingerprint,
				digest: entry.digest,
				chdb: CURRENT_LOCAL_SCHEMA.chdb,
			},
			CURRENT_LOCAL_SCHEMA,
		)
	} catch (error) {
		fail(
			`local schema history entry v${entry.version} cannot reach current v${CURRENT_LOCAL_SCHEMA.version} through the registered migration graph: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
}

const historyPath = "packages/local-server/src/local-schema-history.ts"
const SNAPSHOT_DIR = "packages/local-server/src/schema/history"
// Where the snapshots lived before they moved next to the history they define.
const LEGACY_SNAPSHOT_DIR = "apps/cli/src/server/schema"

const baseRef = process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : "origin/main"
const baseRefExists = ((): boolean => {
	try {
		execFileSync("git", ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`], {
			stdio: ["ignore", "ignore", "ignore"],
		})
		return true
	} catch {
		return false
	}
})()
// `git show <missing-ref>:<path>` and `git show <ref>:<missing-path>` both exit
// 128, so without this the append-only comparison would silently no-op whenever
// the base ref was never fetched, the exact case the gate exists to catch. On a
// PR the workflow fetches it explicitly, so its absence there is a real failure;
// a push build or a local run has no base to compare against and only warns.
if (!baseRefExists) {
	if (process.env.GITHUB_BASE_REF)
		fail(`${baseRef} is not available; fetch the base branch before running this gate`)
	console.warn(`skipping the append-only history comparison: ${baseRef} is not available`)
}

const gitShow = (path: string): string =>
	execFileSync("git", ["show", `${baseRef}:${path}`], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	})

if (baseRefExists) {
	// Every snapshot the base branch shipped must stay byte-identical: each one
	// defines a historical identity that stores and journals already carry.
	const baseSnapshots = execFileSync(
		"git",
		["ls-tree", "--name-only", baseRef, "--", `${SNAPSHOT_DIR}/`, `${LEGACY_SNAPSHOT_DIR}/`],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
	)
	const shipped = Arr.filter(Str.split("\n")(Str.trim(baseSnapshots)), (path) =>
		/\/local-schema-v\d+\.sql$/.test(path),
	)
	for (const path of shipped) {
		const current = `${SNAPSHOT_DIR}/${path.slice(path.lastIndexOf("/") + 1)}`
		if (!existsSync(current) || readFileSync(current, "utf8") !== gitShow(path))
			fail(
				`the shipped local schema snapshot ${path} changed or disappeared; snapshots are append-only`,
			)
	}

	try {
		const baseSource = gitShow(historyPath)
		const controlSection =
			/LOCAL_CONTROL_SCHEMA_HISTORY = Object\.freeze\(\[([\s\S]*?)\] as const\)/.exec(
				baseSource,
			)?.[1] ?? ""
		if (Str.includes("LOCAL_CONTROL_SCHEMA_HISTORY")(baseSource) && Str.trim(controlSection) === "")
			fail("could not parse the base branch control schema history")
		const baseControl = Array.from(
			controlSection.matchAll(/version:\s*(\d+),\s*digest:\s*"([0-9a-f]{64})"/g),
			(match) => ({ version: Number(match[1]), digest: match[2] }),
		)
		if (encodeJson(LOCAL_CONTROL_SCHEMA_HISTORY.slice(0, baseControl.length)) !== encodeJson(baseControl))
			fail("control schema history is not append-only")
	} catch (error) {
		// The base ref exists, so a 128 here means the first commit that introduces the
		// history has no base file. A later run takes the strict prefix path above.
		if (
			typeof error !== "object" ||
			error === null ||
			!("status" in error) ||
			(error as { readonly status?: unknown }).status !== 128
		)
			throw error
	}
}

const controlTip = LOCAL_CONTROL_SCHEMA_HISTORY.at(-1)
const controlSql = readFileSync("packages/local-server/src/schema/control-schema.sql", "utf8")
const controlDigest = (sql: string) => createHash("sha256").update(sql).digest("hex")
if (controlTip?.version !== LOCAL_CONTROL_SCHEMA_VERSION || controlTip.digest !== controlDigest(controlSql))
	fail("control schema changed without a versioned identity; run local-schema:bump --control")
if (!Str.includes(`PRAGMA user_version = ${LOCAL_CONTROL_SCHEMA_VERSION};`)(controlSql))
	fail("control DDL pragma does not match its version identity")
for (const [index, entry] of LOCAL_CONTROL_SCHEMA_HISTORY.entries()) {
	if (entry.version !== index + 1) fail("control schema history versions must be sequential from 1")
	const snapshot = readFileSync(
		`packages/local-server/src/schema/control-schema-v${entry.version}.sql`,
		"utf8",
	)
	if (controlDigest(snapshot) !== entry.digest) fail(`immutable control schema v${entry.version} drifted`)
}

console.log(
	`local structural schema manifest is up to date (schema v${LOCAL_SCHEMA_VERSION}, ${LOCAL_SCHEMA_MANIFEST.objects.length} objects, ${LOCAL_SCHEMA_MANIFEST_DIGEST}; ${LOCAL_SCHEMA_HISTORY_TIP + 1} historical identities)`,
)
