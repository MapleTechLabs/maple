import { assert, describe, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { Effect } from "effect"
import { FileSystem } from "effect/FileSystem"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { commandEnvironment, makeSandboxRuntime, resolveWorkspacePath } from "./exec"

const SHA = "a".repeat(40)
const OTHER = "b".repeat(40)

/** A workspace root with one checkout holding a couple of files. */
const makeRoot = () => {
	const root = mkdtempSync(`${tmpdir()}/maple-sandbox-`)
	mkdirSync(`${root}/${SHA}/src`, { recursive: true })
	writeFileSync(
		`${root}/${SHA}/src/checkout.ts`,
		"export const checkout = 1\nthrow new Error('card declined')\n",
	)
	writeFileSync(`${root}/${SHA}/README.md`, "# shop\n")
	return root
}

const runtimeFor = (root: string) =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner
		const fs = yield* FileSystem
		return makeSandboxRuntime({ spawner, fs, root, environment: process.env })
	})

const exec = (
	root: string,
	command: string,
	args: ReadonlyArray<string>,
	overrides: Partial<{ cwd: string; maxOutputBytes: number; maxWallTimeMs: number; sha: string }> = {},
) =>
	runtimeFor(root).pipe(
		Effect.flatMap((runtime) =>
			runtime.exec({
				sha: overrides.sha ?? SHA,
				command,
				args,
				cwd: overrides.cwd ?? ".",
				envAllow: ["PATH"],
				maxOutputBytes: overrides.maxOutputBytes ?? 64 * 1024,
				maxWallTimeMs: overrides.maxWallTimeMs ?? 10_000,
			}),
		),
		Effect.provide(NodeServices.layer),
	)

describe("resolveWorkspacePath", () => {
	it("keeps a relative path inside the workspace", () => {
		assert.strictEqual(resolveWorkspacePath("/w", "."), "/w")
		assert.strictEqual(resolveWorkspacePath("/w", "src/./lib"), "/w/src/lib")
		assert.strictEqual(resolveWorkspacePath("/w", "src/../docs"), "/w/docs")
	})
	it("refuses a path that climbs out", () => {
		assert.isUndefined(resolveWorkspacePath("/w", "../etc"))
		assert.isUndefined(resolveWorkspacePath("/w", "src/../../etc"))
	})
})

describe("commandEnvironment", () => {
	it("copies only allowed names from the safe set", () => {
		const env = commandEnvironment({ PATH: "/bin", HOME: "/root", SECRET: "x", LANG: "C" }, [
			"PATH",
			"SECRET",
			"LANG",
		])
		assert.deepStrictEqual(env, { PATH: "/bin", LANG: "C" })
	})
})

describe("the sandbox runtime", () => {
	it.live("runs a command in the checkout and reports its exit code and output", () =>
		Effect.gen(function* () {
			const root = makeRoot()
			const output = yield* exec(root, "cat", ["src/checkout.ts"])
			assert.strictEqual(output._tag, "exited")
			if (output._tag !== "exited") return
			assert.strictEqual(output.exitCode, 0)
			assert.include(output.stdout, "card declined")
			assert.strictEqual(output.stderrBytes, 0)
		}),
	)

	it.live("resolves cwd inside the workspace and refuses an escape", () =>
		Effect.gen(function* () {
			const root = makeRoot()
			const inside = yield* exec(root, "ls", [], { cwd: "src" })
			assert.strictEqual(inside._tag, "exited")
			if (inside._tag === "exited") assert.include(inside.stdout, "checkout.ts")
			const escaped = yield* exec(root, "ls", [], { cwd: "../.." })
			assert.strictEqual(escaped._tag, "spawn-failed")
		}),
	)

	it.live("reports a missing checkout instead of running against nothing", () =>
		Effect.gen(function* () {
			const output = yield* exec(makeRoot(), "ls", [], { sha: OTHER })
			assert.deepStrictEqual(output, { _tag: "missing-workspace", sha: OTHER })
		}),
	)

	it.live("stops reading past the output bound", () =>
		Effect.gen(function* () {
			const output = yield* exec(makeRoot(), "sh", ["-c", "yes | head -c 200000"], {
				maxOutputBytes: 4096,
			})
			assert.strictEqual(output._tag, "output-limit", JSON.stringify(output))
			if (output._tag === "output-limit") {
				assert.strictEqual(output.stream, "stdout")
				assert.isAbove(output.observed, 4096)
			}
		}),
	)

	it.live("kills a command that outlives its wall clock", () =>
		Effect.gen(function* () {
			const output = yield* exec(makeRoot(), "sleep", ["30"], { maxWallTimeMs: 300 })
			assert.strictEqual(output._tag, "timed-out")
		}),
	)

	it.live("restores a GitHub-shaped tarball as a read-only checkout and lists it", () =>
		Effect.gen(function* () {
			const root = mkdtempSync(`${tmpdir()}/maple-sandbox-`)
			const source = mkdtempSync(`${tmpdir()}/maple-archive-`)
			mkdirSync(`${source}/octo-shop-abc1234/src`, { recursive: true })
			writeFileSync(`${source}/octo-shop-abc1234/src/index.ts`, "export {}\n")
			execFileSync("tar", ["-czf", `${source}/archive.tgz`, "-C", source, "octo-shop-abc1234"])
			const fs = yield* FileSystem
			const runtime = yield* runtimeFor(root)
			const restored = yield* runtime.restoreArchive(SHA, fs.stream(`${source}/archive.tgz`))
			assert.isAbove(restored.bytes, 0)
			assert.isTrue(yield* fs.exists(`${root}/${SHA}/src/index.ts`))
			const workspaces = yield* runtime.listWorkspaces()
			assert.deepStrictEqual(
				workspaces.map((workspace) => workspace.sha),
				[SHA],
			)
			yield* runtime.removeWorkspace(SHA)
			assert.deepStrictEqual(yield* runtime.listWorkspaces(), [])
		}).pipe(Effect.provide(NodeServices.layer)),
	)
})
