import { readdirSync } from "node:fs"
import { join } from "node:path"
import { defineConfig } from "drizzle-kit"

// Local-only (gitignored): browse the live local D1 (miniflare) sqlite in Drizzle Studio.
//   bun drizzle-kit studio --config ./drizzle.config.local.ts
// Run `bun dev` in apps/api first so the local D1 file exists.

const d1Dir =
	"/Users/jeremyfunk/Documents/repos/maple/apps/api/.wrangler/state/v3/d1/miniflare-D1DatabaseObject"

const dbFile = (() => {
	let file: string | undefined
	try {
		file = readdirSync(d1Dir).find((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite")
	} catch {
		// fall through to the error below
	}
	if (!file) {
		throw new Error(
			`Local D1 database not found in ${d1Dir}.\n` +
				"Run `bun dev` (or `wrangler d1 migrations apply maple-api-local --local`) in apps/api first.",
		)
	}
	return join(d1Dir, file)
})()

export default defineConfig({
	schema: "./src/schema/index.ts",
	out: "./drizzle",
	dialect: "sqlite",
	dbCredentials: { url: `file:${dbFile}` },
})
