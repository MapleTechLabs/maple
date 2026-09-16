/**
 * `migrations-preflight.ts` against a PlanetScale branch, over the same
 * ephemeral credential `ps:apply-schema` uses. Read-only.
 *
 *   bun run --cwd packages/db ps:migrations-preflight main
 */
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { fail, withBranchConnection } from "./planetscale-connection"

const branch = process.argv[2]?.trim()
if (!branch) fail("Usage: bun packages/db/scripts/planetscale-migrations-preflight.ts <branch>")

await withBranchConnection(branch as string, async (connectionUrl) => {
	const proc = spawnSync("bun", ["scripts/migrations-preflight.ts"], {
		cwd: resolve(import.meta.dir, ".."),
		env: { ...process.env, DATABASE_URL: connectionUrl },
		stdio: "inherit",
	})
	if (proc.status !== 0) fail("migrations preflight found rows the v1 migrator would refuse")
})
