import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { formatRepoTree, REPO_TREE_COMMAND } from "./repo-tree"

const repoWith = (files: ReadonlyArray<string>) => {
	const dir = mkdtempSync(join(tmpdir(), "repo-tree-"))
	execFileSync("git", ["init", "--quiet", dir])
	files.forEach((file) => {
		mkdirSync(join(dir, file, ".."), { recursive: true })
		writeFileSync(join(dir, file), "x\n")
	})
	execFileSync("git", ["-C", dir, "add", "-A"])
	return dir
}

const treeOf = (dir: string) => {
	const probe = spawnSync(REPO_TREE_COMMAND.command, [...REPO_TREE_COMMAND.args], {
		cwd: dir,
		encoding: "utf8",
	})
	return formatRepoTree(probe.stdout, false)
}

describe("the repository tree", () => {
	it("lists tracked directories to depth 3 as an indented tree, without files", () => {
		const dir = repoWith([
			"README.md",
			"apps/api/src/routes/keys.ts",
			"apps/api-gateway/index.ts",
			"packages/domain/src/auth.ts",
		])
		expect(treeOf(dir).split("\n")).toEqual([
			"apps/",
			"  api/",
			"    src/",
			"  api-gateway/",
			"packages/",
			"  domain/",
			"    src/",
		])
	})

	it("drops depth before breadth when the repository is over the budget", () => {
		const top = Array.from({ length: 30 }, (_, i) => `pkg-${String(i).padStart(2, "0")}`)
		const listing = top.flatMap((name) => [name, `${name}/src`, `${name}/src/internal`]).join("\n")
		const tree = formatRepoTree(listing, false, 600)
		expect(new TextEncoder().encode(tree).length).toBeLessThanOrEqual(600)
		expect(top.every((name) => tree.includes(`${name}/`))).toBe(true)
		expect(tree).not.toContain("internal/")
		expect(tree).toContain("use list_files")
	})

	it("drops a half-printed last line from a cut listing", () => {
		expect(formatRepoTree("apps\npackages\npack", true)).toBe(
			"apps/\npackages/\n(deeper or further directories omitted: use list_files)",
		)
	})
})
