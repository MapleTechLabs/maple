import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import { OrgId, UserId } from "@maple/domain"
import { expect, it } from "vitest"
import { makeExecutor } from "../../scripts/pr-review-local"

it("historical replay reads its head but cannot read a future fix or execute git", async () => {
	const dir = mkdtempSync(join(tmpdir(), "review-replay-"))
	const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim()
	try {
		git("init", "--quiet")
		git("config", "user.email", "eval@example.test")
		git("config", "user.name", "Eval")
		writeFileSync(join(dir, "code.ts"), "historical bug\n")
		git("add", ".")
		git("commit", "--quiet", "-m", "old change")
		const headSha = git("rev-parse", "HEAD")
		writeFileSync(join(dir, "code.ts"), "future fix\n")
		git("commit", "--quiet", "-am", "fix")
		const future = git("rev-parse", "HEAD")
		const { executor } = makeExecutor({
			repository: "test/repo",
			number: 1,
			files: [],
			context: undefined,
			dir,
			headSha,
			allowExec: true,
			historical: true,
		})
		const tenant = {
			orgId: Schema.decodeSync(OrgId)("org_eval"),
			userId: Schema.decodeSync(UserId)("internal-service"),
			roles: [],
			authMode: "self_hosted" as const,
		}
		const call = (name: string, args: Record<string, unknown>) =>
			Effect.runPromise(executor.execute(tenant, name, args))
		expect(JSON.stringify(await call("sandbox_read_file", { path: "code.ts" }))).toContain(
			"historical bug",
		)
		expect((await call("sandbox_grep", { pattern: "historical", glob: "**/*.{ts,tsx}" })).isError).toBe(
			true,
		)
		expect(JSON.stringify(await call("sandbox_read_file", { path: "code.ts", endLine: 3 }))).toContain(
			"endLine",
		)
		const blocked = await call("sandbox_read_file", { path: "code.ts", ref: future })
		expect(blocked.isError).toBe(true)
		expect(JSON.stringify(blocked)).not.toContain("future fix")
		expect((await call("sandbox_exec", { command: "git", args: ["show", future] })).isError).toBe(true)
		expect(
			(await call("sandbox_exec", { command: "node", args: ["-e", "process.exit(0)"] })).isError,
		).toBe(true)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})
