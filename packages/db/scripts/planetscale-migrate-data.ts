#!/usr/bin/env bun
/**
 * Import D1 data into a PlanetScale branch, brokering the connection through the
 * PlanetScale CLI. Thin wrapper around d1-to-postgres-migrate.ts (which owns the
 * SQLite→Postgres transform + verification) that mints/revokes the branch
 * credential AND, if you don't hand it a dump, exports one from D1 first.
 *
 *   # Auto-export the prod D1 then import (needs Cloudflare auth — see below):
 *   PLANETSCALE_ORG=<org> bun packages/db/scripts/planetscale-migrate-data.ts <branch>
 *
 *   # Or pass an existing dump to skip the export:
 *   bun packages/db/scripts/planetscale-migrate-data.ts <branch> .migration/d1-dump.sql
 *
 * The dump comes from `wrangler d1 export <d1-name> --remote` (the prod D1 is
 * `maple-api`; override with MAPLE_D1_DATABASE). `--remote` pulls real prod data,
 * so wrangler must be authenticated to the Cloudflare account — either
 * `wrangler login`, or CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID in the env.
 *
 * Run apply-schema on the branch first (the import needs the tables). Mints an
 * ephemeral credential (direct port 5432), imports, verifies per-table row
 * counts, then revokes. Rerunnable: truncate the branch first if a previous run
 * partially imported.
 */
import { spawnSync } from "node:child_process"
import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { fail, resolveDatabase, withBranchConnection } from "./planetscale-connection"

const branch = process.argv[2]?.trim()
let dumpPath = process.argv[3]?.trim()
if (!branch) {
	fail("Usage: bun packages/db/scripts/planetscale-migrate-data.ts <branch> [d1-dump.sql]")
}

const packageDir = resolve(import.meta.dir, "..")
const importScript = resolve(import.meta.dir, "d1-to-postgres-migrate.ts")

/** Export the prod D1 to a local .sql dump via wrangler. Returns the dump path. */
const exportD1Dump = (): string => {
	const d1Name = process.env.MAPLE_D1_DATABASE?.trim() || "maple-api"
	const local = process.env.MAPLE_D1_EXPORT_LOCAL?.trim() === "true"
	const outDir = resolve(packageDir, ".migration")
	mkdirSync(outDir, { recursive: true })
	const outPath = resolve(outDir, `d1-${d1Name}-${process.pid}.sql`)
	console.log(`→ Exporting D1 \`${d1Name}\` (${local ? "local" : "remote"}) → ${outPath}\n`)
	const proc = spawnSync(
		"bunx",
		[
			"wrangler",
			"d1",
			"export",
			d1Name,
			local ? "--local" : "--remote",
			"--output",
			outPath,
			"--skip-confirmation",
		],
		{ cwd: packageDir, stdio: "inherit" },
	)
	if (proc.status !== 0) {
		fail(
			"wrangler d1 export failed — is wrangler authenticated? (`wrangler login`, or set CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID)",
		)
	}
	console.log()
	return outPath
}

if (!dumpPath) {
	dumpPath = exportD1Dump()
}

await withBranchConnection(branch as string, async (connectionUrl) => {
	console.log(`→ Importing ${dumpPath} into ${resolveDatabase()}/${branch}\n`)
	const proc = spawnSync("bun", [importScript, dumpPath as string], {
		env: { ...process.env, DATABASE_URL: connectionUrl },
		stdio: "inherit",
	})
	if (proc.status !== 0) {
		fail("data migration failed — branch was NOT fully imported")
	}
})
