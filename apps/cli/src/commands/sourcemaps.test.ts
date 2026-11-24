import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, Option, String as Str } from "effect"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SourceMapUploadError } from "../core/sourcemaps-upload"
import { checkUploadOutcomes, gitHead } from "./sourcemaps"

let dir = ""
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "maple-sourcemaps-cmd-"))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const git = (...args: ReadonlyArray<string>) =>
	Str.trim(execFileSync("git", [...args], { cwd: dir, encoding: "utf8" }))

describe("gitHead", () => {
	test("reads the commit of the build directory's checkout, not the shell's", async () => {
		git("init", "-q")
		writeFileSync(join(dir, "a.txt"), "a")
		git("add", "a.txt")
		git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init")
		const buildHead = git("rev-parse", "HEAD")
		const shellHead = Str.trim(execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }))

		const head = await Effect.runPromise(Effect.provide(gitHead(dir), BunServices.layer))

		expect(Option.getOrNull(head)).toBe(buildHead)
		expect(buildHead).not.toBe(shellHead)
	})

	test("is none outside a git work tree", async () => {
		const head = await Effect.runPromise(Effect.provide(gitHead(dir), BunServices.layer))
		expect(Option.isNone(head)).toBe(true)
	})
})

describe("checkUploadOutcomes", () => {
	const skipped = { _tag: "skipped", minifiedPath: "a.js", reason: "no debug id" } as const
	const uploaded = {
		_tag: "uploaded",
		minifiedPath: "b.js",
		debugId: Option.none(),
		sizeBytes: 1,
		id: Option.none(),
	} as const

	test("fails when every map was skipped, so CI does not go on without maps", async () => {
		const error = await Effect.runPromise(Effect.flip(checkUploadOutcomes("dist", [skipped, skipped])))
		expect(error._tag).toBe("@maple/cli/UsageError")
		expect(error.message).toBe("no source maps were uploaded; every matching map was skipped")
	})

	test("passes when at least one map went up, and reports a failed one", async () => {
		await Effect.runPromise(checkUploadOutcomes("dist", [skipped, uploaded]))
		const failed = {
			_tag: "failed",
			minifiedPath: "c.js",
			error: new SourceMapUploadError({ message: "HTTP 400: bad", minifiedPath: "c.js", status: 400 }),
		} as const
		const error = await Effect.runPromise(Effect.flip(checkUploadOutcomes("dist", [uploaded, failed])))
		expect(error._tag).not.toBe("@maple/cli/UsageError")
	})
})
