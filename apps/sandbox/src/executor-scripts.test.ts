import { spawnSync } from "node:child_process"
import { linkSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import { EXECUTOR_LIMITS, ExecutorPromotion } from "@maple/domain/executor"
import { Schema } from "effect"
import {
	RUN_TRAILER,
	lockfilePlanScript,
	parsePrepareStatus,
	parseRunOutput,
	promoteScript,
} from "./executor-scripts"

const run = (command: string, cwd: string) => {
	const result = spawnSync("bash", ["-c", command], { cwd, encoding: "utf8" })
	assert.strictEqual(result.status, 0, result.stderr)
	return result.stdout
}

const tempDir = (prefix: string) => mkdtempSync(join(tmpdir(), prefix))

const repoWith = (files: ReadonlyArray<string>) => {
	const dir = tempDir("maple-executor-plan-")
	for (const file of files) {
		mkdirSync(join(dir, file, ".."), { recursive: true })
		writeFileSync(join(dir, file), "{}\n")
	}
	run("git init -q . && git add -A && git -c user.email=t@t -c user.name=t commit -qm init", dir)
	return dir
}

describe("lockfilePlanScript", () => {
	it("installs each lockfile directory once, with the preferred manager, shallowest first", () => {
		const dir = repoWith([
			"package-lock.json",
			"apps/web/pnpm-lock.yaml",
			"apps/web/package-lock.json",
			"tools/bun.lock",
			"tools/package-lock.json",
			"legacy/yarn.lock",
			"vendor/node_modules/left-pad/package-lock.json",
			"README.md",
		])
		assert.deepStrictEqual(run(lockfilePlanScript(), dir).trim().split("\n"), [
			".\tnpm",
			"legacy\tyarn",
			"tools\tbun",
			"apps/web\tpnpm",
		])
	})

	it("caps how many directories install", () => {
		const dir = repoWith(
			Array.from({ length: 12 }, (_, i) => `pkg${String(i).padStart(2, "0")}/package-lock.json`),
		)
		assert.strictEqual(run(lockfilePlanScript(), dir).trim().split("\n").length, 8)
	})

	it("plans nothing for a repository without lockfiles", () => {
		assert.strictEqual(run(lockfilePlanScript(), repoWith(["package.json"])).trim(), "")
	})
})

describe("parsePrepareStatus", () => {
	it("reads a ready checkout with its installs", () => {
		const status = parsePrepareStatus(
			`ready ${"a".repeat(40)}\n.\tnpm\tinstalled\tadded 12 packages\napps/x\tyarn\tskipped\tyarn lockfiles are not installed yet\n`,
		)
		assert.deepStrictEqual(status, {
			_tag: "ready",
			sha: "a".repeat(40),
			installs: [
				{ dir: ".", manager: "npm", outcome: "installed", detail: "added 12 packages" },
				{
					dir: "apps/x",
					manager: "yarn",
					outcome: "skipped",
					detail: "yarn lockfiles are not installed yet",
				},
			],
		})
	})

	it("reads a failure with its log", () => {
		assert.deepStrictEqual(parsePrepareStatus("failed 11\nfatal: could not read from remote\n"), {
			_tag: "failed",
			code: "11",
			log: "fatal: could not read from remote",
		})
	})

	it("treats an unknown answer as a failure, not as ready", () => {
		assert.strictEqual(parsePrepareStatus("bash: something broke")._tag, "failed")
	})
})

describe("parseRunOutput", () => {
	it("splits the command's output from the trailer, the last trailer winning", () => {
		const parsed = parseRunOutput(
			`hello\n${RUN_TRAILER} started 9 9 0\nmore\n\n${RUN_TRAILER} started 3 120 7\n`,
		)
		assert.deepStrictEqual(parsed?.trailer, {
			state: "started",
			exitCode: 3,
			stdoutBytes: 120,
			stderrBytes: 7,
		})
		assert.strictEqual(parsed?.body, `hello\n${RUN_TRAILER} started 9 9 0\nmore\n`)
	})

	it("refuses output without a readable trailer", () => {
		assert.isUndefined(parseRunOutput("no trailer here"))
		assert.isUndefined(parseRunOutput(`${RUN_TRAILER} exploded x y z`))
	})
})

const decodePromotion = Schema.decodeUnknownSync(
	Schema.fromJsonString(
		Schema.Struct({
			promoted: Schema.Array(
				Schema.Struct({
					path: Schema.String,
					bytes: Schema.Finite,
					sha256: Schema.String,
					preview: Schema.String,
				}),
			),
			rejected: Schema.Array(Schema.Struct({ path: Schema.String, reason: Schema.String })),
		}),
	),
)

/** The real helper, as the executor runs it, over a scratch and an artifacts directory. */
const promote = (
	scratch: string,
	artifacts: string,
	entries: ReadonlyArray<{ path: string; maxBytes: number }>,
) => {
	const script = promoteScript(
		"agent-1",
		entries.map((entry) => new ExecutorPromotion(entry)),
	)
		.replace("/usr/local/lib/maple/promote.py", join(import.meta.dirname, "../image/promote.py"))
		.replace("/audit/agents/agent-1/scratch", scratch)
		.replace("/audit/agents/agent-1/artifacts", artifacts)
	const result = spawnSync("bash", ["-c", script], { encoding: "utf8" })
	assert.strictEqual(result.status, 0, result.stderr)
	return decodePromotion(result.stdout)
}

const promotionDirs = () => {
	const root = tempDir("maple-executor-promote-")
	const scratch = join(root, "scratch")
	const artifacts = join(root, "artifacts")
	mkdirSync(scratch)
	mkdirSync(artifacts)
	return { root, scratch, artifacts }
}

describe("promote.py", () => {
	it("copies a declared regular file into artifacts, with its hash and a preview", () => {
		const { scratch, artifacts } = promotionDirs()
		mkdirSync(join(scratch, "poc"))
		writeFileSync(join(scratch, "poc/out.txt"), "leaked: other-tenant-row\n")
		const result = promote(scratch, artifacts, [{ path: "poc/out.txt", maxBytes: 1024 }])
		assert.deepStrictEqual(result.rejected, [])
		assert.strictEqual(result.promoted[0]?.bytes, 25)
		assert.strictEqual(result.promoted[0]?.preview, "leaked: other-tenant-row\n")
		assert.match(result.promoted[0]?.sha256 ?? "", /^[0-9a-f]{64}$/u)
		assert.strictEqual(readFileSync(join(artifacts, "poc/out.txt"), "utf8"), "leaked: other-tenant-row\n")
	})

	it("refuses symlinks, symlinked directories, hard links, FIFOs, directories and missing files", () => {
		const { root, scratch, artifacts } = promotionDirs()
		writeFileSync(join(root, "secret"), "outside scratch\n")
		symlinkSync(join(root, "secret"), join(scratch, "link"))
		symlinkSync(root, join(scratch, "dirlink"))
		writeFileSync(join(scratch, "linked"), "two names\n")
		linkSync(join(scratch, "linked"), join(scratch, "linked-again"))
		run(`mkfifo ${join(scratch, "fifo")}`, scratch)
		mkdirSync(join(scratch, "adir"))
		const result = promote(
			scratch,
			artifacts,
			["link", "dirlink/secret", "linked", "fifo", "adir", "missing"].map((path) => ({
				path,
				maxBytes: 1024,
			})),
		)
		assert.deepStrictEqual(result.promoted, [])
		assert.deepStrictEqual(
			result.rejected.map((rejected) => rejected.path),
			["link", "dirlink/secret", "linked", "fifo", "adir", "missing"],
		)
		assert.include(result.rejected[2]?.reason, "link count")
		assert.strictEqual(spawnSync("ls", ["-A", artifacts], { encoding: "utf8" }).stdout, "")
	})

	it("holds each file to its own limit and all files to the total", () => {
		const { scratch, artifacts } = promotionDirs()
		writeFileSync(join(scratch, "big"), "x".repeat(2000))
		writeFileSync(join(scratch, "a"), "a".repeat(600 * 1024))
		writeFileSync(join(scratch, "b"), "b".repeat(200 * 1024))
		writeFileSync(join(scratch, "c"), "c".repeat(250 * 1024))
		const result = promote(scratch, artifacts, [
			{ path: "big", maxBytes: 1000 },
			{ path: "a", maxBytes: EXECUTOR_LIMITS.promotedFileBytes },
			{ path: "b", maxBytes: EXECUTOR_LIMITS.promotedFileBytes },
			{ path: "c", maxBytes: EXECUTOR_LIMITS.promotedFileBytes },
		])
		assert.deepStrictEqual(
			result.promoted.map((artifact) => artifact.path),
			["b", "c"],
		)
		assert.deepStrictEqual(
			result.rejected.map((rejected) => rejected.path),
			["big", "a"],
		)
	})

	it("refuses the file that would take the promoted total past its limit, each file under its own", () => {
		const { scratch, artifacts } = promotionDirs()
		const names = ["p1", "p2", "p3", "p4", "p5"]
		for (const name of names) writeFileSync(join(scratch, name), "z".repeat(250 * 1024))
		const result = promote(
			scratch,
			artifacts,
			names.map((path) => ({ path, maxBytes: EXECUTOR_LIMITS.promotedFileBytes })),
		)
		// 1 MiB holds four 250 KiB files; the fifth would pass it.
		assert.deepStrictEqual(
			result.promoted.map((artifact) => artifact.path),
			["p1", "p2", "p3", "p4"],
		)
		assert.deepStrictEqual(
			result.rejected.map((rejected) => rejected.path),
			["p5"],
		)
	})

	it("never overwrites an artifact, and never writes through a symlink planted in artifacts", () => {
		const { root, scratch, artifacts } = promotionDirs()
		writeFileSync(join(scratch, "out"), "first\n")
		assert.strictEqual(promote(scratch, artifacts, [{ path: "out", maxBytes: 100 }]).promoted.length, 1)
		writeFileSync(join(scratch, "out2"), "second\n")
		symlinkSync(join(root, "elsewhere"), join(artifacts, "out2"))
		const again = promote(scratch, artifacts, [
			{ path: "out", maxBytes: 100 },
			{ path: "out2", maxBytes: 100 },
		])
		assert.deepStrictEqual(again.promoted, [])
		assert.strictEqual(readFileSync(join(artifacts, "out"), "utf8"), "first\n")
		assert.isFalse(spawnSync("test", ["-e", join(root, "elsewhere")]).status === 0)
	})
})
