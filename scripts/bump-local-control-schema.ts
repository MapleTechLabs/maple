/** Scaffold an independent SQLite control-schema identity; the author supplies its migration edge. */
import { createHash } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { LOCAL_CONTROL_SCHEMA_VERSION } from "../apps/cli/src/server/local-schema-version"

const root = "apps/cli/src/server"
const next = LOCAL_CONTROL_SCHEMA_VERSION + 1
const currentPath = `${root}/schema/control-schema.sql`
const snapshotPath = `${root}/schema/control-schema-v${next}.sql`
if (existsSync(snapshotPath)) throw new Error(`control schema v${next} already exists`)
const current = readFileSync(currentPath, "utf8")
const pragma = `PRAGMA user_version = ${LOCAL_CONTROL_SCHEMA_VERSION};`
if (!current.includes(pragma)) throw new Error("current control schema version pragma does not match")
const sql = current.replace(pragma, `PRAGMA user_version = ${next};`)
const digest = createHash("sha256").update(sql).digest("hex")
const versionPath = `${root}/local-schema-version.ts`
const historyPath = `${root}/local-schema-history.ts`
const currentVersion = readFileSync(versionPath, "utf8")
const versionAnchor = `LOCAL_CONTROL_SCHEMA_VERSION = ${LOCAL_CONTROL_SCHEMA_VERSION} as const`
if (currentVersion.split(versionAnchor).length !== 2)
	throw new Error("control version anchor must occur exactly once")
const version = currentVersion.replace(
	`LOCAL_CONTROL_SCHEMA_VERSION = ${LOCAL_CONTROL_SCHEMA_VERSION} as const`,
	`LOCAL_CONTROL_SCHEMA_VERSION = ${next} as const`,
)
const history = readFileSync(historyPath, "utf8")
const tip = /export const LOCAL_CONTROL_SCHEMA_HISTORY = Object\.freeze\(\[([\s\S]*?)\] as const\)/
if (!tip.test(history)) throw new Error("control schema history anchor not found")
const updatedHistory = history.replace(
	tip,
	(_all, entries: string) =>
		`export const LOCAL_CONTROL_SCHEMA_HISTORY = Object.freeze([${entries}\tObject.freeze({ version: ${next}, digest: "${digest}" }),\n] as const)`,
)
for (const [path, content] of [
	[currentPath, sql],
	[snapshotPath, sql],
	[versionPath, version],
	[historyPath, updatedHistory],
] as const)
	writeFileSync(path, content)
console.log(
	`Scaffolded control schema v${next}. Add and test a transactional migration from v${LOCAL_CONTROL_SCHEMA_VERSION} in eventing/control-store.ts before shipping; run clickhouse:schema:check and CLI tests.`,
)
