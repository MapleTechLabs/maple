// Root-level `vitest` runs each Vitest workspace under its own config, never the
// stale checkouts under .claude/, .context/ or worktrees/. Prefer `bun run test`.
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const root = import.meta.dirname

const runsVitest = (dir: string): boolean => {
	const manifest = join(root, dir, "package.json")
	if (!existsSync(manifest)) return false
	const parsed: { scripts?: { test?: string } } = JSON.parse(readFileSync(manifest, "utf8"))
	return /\bvitest\b/.test(parsed.scripts?.test ?? "")
}

const projects = ["apps", "packages", "lib", "examples"]
	.flatMap((group) => readdirSync(join(root, group)).map((name) => `${group}/${name}`))
	.filter(runsVitest)

export default {
	test: {
		projects,
		exclude: ["**/node_modules/**", "**/.git/**", "**/.claude/**", "**/.context/**", "**/worktrees/**"],
	},
}
