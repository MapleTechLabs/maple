#!/usr/bin/env bun
/**
 * Apply the Drizzle Postgres schema (packages/db/drizzle) to a PlanetScale
 * branch, brokering the connection through the PlanetScale CLI.
 *
 *   PLANETSCALE_ORG=<org> bun packages/db/scripts/planetscale-apply-schema.ts <branch>
 *
 *   # examples
 *   bun packages/db/scripts/planetscale-apply-schema.ts main     # prd
 *   bun packages/db/scripts/planetscale-apply-schema.ts stg
 *   bun packages/db/scripts/planetscale-apply-schema.ts pr-123
 *
 * Mints an ephemeral credential for the branch (direct port 5432 — DDL must NOT
 * go through the PSBouncer/Hyperdrive poolers), runs `drizzle-kit migrate`, then
 * revokes the credential. Idempotent: drizzle skips migrations already recorded
 * in `drizzle.__drizzle_migrations`, so re-running is a no-op on an up-to-date
 * branch.
 */
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { applyRuntimeGrants } from "./grant-runtime-role"
import { fail, resolveDatabase, withBranchConnection } from "./planetscale-connection"

const branch = process.argv[2]?.trim()
if (!branch) {
	fail("Usage: bun packages/db/scripts/planetscale-apply-schema.ts <branch>")
}

const packageDir = resolve(import.meta.dir, "..")

// The runtime app role (the role the deployed worker authenticates as through
// its Hyperdrive binding) differs from the ephemeral migration role used here,
// and table-rebuild migrations strip its grants — so re-grant it after migrate.
// Required for prod (`main`); a clear warning + skip for branches that don't set
// it, so non-prod schema-applies don't fail.
const runtimeRole = process.env.MAPLE_PG_RUNTIME_ROLE?.trim()

await withBranchConnection(branch as string, async (connectionUrl) => {
	console.log(`→ Applying schema to ${resolveDatabase()}/${branch} via drizzle-kit migrate\n`)
	const proc = spawnSync("bun", ["run", "db:migrate"], {
		cwd: packageDir,
		env: { ...process.env, DATABASE_URL: connectionUrl },
		stdio: "inherit",
	})
	if (proc.status !== 0) {
		fail("drizzle-kit migrate failed")
	}
	console.log(`\n✓ Schema applied to ${resolveDatabase()}/${branch}`)

	if (runtimeRole) {
		console.log(`\n→ Re-granting runtime privileges to "${runtimeRole}"\n`)
		await applyRuntimeGrants(connectionUrl, runtimeRole)
	} else {
		console.warn(
			"\n⚠ MAPLE_PG_RUNTIME_ROLE not set — SKIPPING runtime grants. The app role may hit " +
				'"permission denied for table …" after a table rebuild. Set it to the prod Hyperdrive role.',
		)
	}
})
