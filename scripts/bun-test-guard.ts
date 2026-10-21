// Preloaded by `bun test` (bunfig.toml [test] preload). Bun's runner fakes `vitest`
// imports and fails Vitest suites in confusing ways, so any test file owned by a
// Vitest workspace, or by a stray worktree copy, stops the run with one clear message.
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"

const root = dirname(import.meta.dir)

const runsVitest = (packageJson: string): boolean => {
	const manifest: { scripts?: { test?: string } } = JSON.parse(
		readFileSync(join(root, packageJson), "utf8"),
	)
	return /\bvitest\b/.test(manifest.scripts?.test ?? "")
}

const vitestDirs = Array.from(new Bun.Glob("{apps,packages,lib,examples}/*/package.json").scanSync(root))
	.filter(runsVitest)
	.map(dirname)

const escape = (path: string) => path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const owned = [...vitestDirs, ".claude", ".context", "worktrees"].map((dir) => escape(join(root, dir)))
const filter = new RegExp(`^(${owned.join("|")})/.*\\.(test|spec)\\.[cm]?[jt]sx?$`)

Bun.plugin({
	name: "maple-vitest-guard",
	setup(build) {
		build.onLoad({ filter }, (args) => {
			const file = args.path.slice(root.length + 1)
			console.error(
				`\n${file} belongs to a Vitest suite; \`bun test\` runs Bun's own runner, which cannot run it.\n` +
					"This package uses Vitest: run `bun run test` in the package (or `bunx vitest run <file>`).\n" +
					"Only apps/cli and scripts/ use `bun test`.\n",
			)
			process.exit(1)
		})
	},
})
