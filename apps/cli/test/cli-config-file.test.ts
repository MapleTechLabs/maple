import { describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunFileSystem } from "@effect/platform-bun"
import { Effect, Exit } from "effect"
import { FileSystem } from "effect/FileSystem"
import { readConfigFile, storedTokenFor, writeConfigFile, type StoredConfig } from "../src/core/config"

const withDir = async (run: (dir: string) => Promise<void>) => {
	const dir = mkdtempSync(join(tmpdir(), "maple-config-"))
	try {
		await run(dir)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

const write = (path: string, mutate: (cur: StoredConfig) => StoredConfig) =>
	Effect.runPromiseExit(
		Effect.gen(function* () {
			return yield* writeConfigFile(yield* FileSystem, path, mutate)
		}).pipe(Effect.provide(BunFileSystem.layer)),
	)

const read = (path: string) =>
	Effect.runPromiseExit(
		Effect.gen(function* () {
			return yield* readConfigFile(yield* FileSystem, path)
		}).pipe(Effect.provide(BunFileSystem.layer)),
	)

describe("CLI config file", () => {
	test("replaces the file atomically with owner-only permissions and keeps unknown keys", () =>
		withDir(async (dir) => {
			const path = join(dir, "config.json")
			writeFileSync(
				path,
				JSON.stringify({ token: "t", apiUrl: "https://api.maple.dev", future: { a: 1 } }),
			)
			expect(Exit.isSuccess(await write(path, (cur) => ({ ...cur, defaultMode: "local" })))).toBe(true)
			expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
				future: { a: 1 },
				token: "t",
				apiUrl: "https://api.maple.dev",
				defaultMode: "local",
			})
			expect(statSync(path).mode & 0o777).toBe(0o600)
			expect(readdirSync(dir)).toEqual(["config.json"])
		}))

	test("never merges over an unparseable file", () =>
		withDir(async (dir) => {
			const path = join(dir, "config.json")
			writeFileSync(path, '{"token": "keep-me", ')
			const exit = await write(path, (cur) => ({ ...cur, defaultMode: "local" }))
			expect(Exit.isFailure(exit)).toBe(true)
			expect(JSON.stringify(exit)).toContain(path)
			expect(readFileSync(path, "utf8")).toBe('{"token": "keep-me", ')
			expect(Exit.isFailure(await read(path))).toBe(true)
		}))

	test("treats a missing file as an empty config", () =>
		withDir(async (dir) => {
			const exit = await read(join(dir, "config.json"))
			expect(Exit.isSuccess(exit) && exit.value).toEqual({})
		}))

	test("only hands a file-stored token to the API origin that issued it", () => {
		const stored: StoredConfig = { apiUrl: "https://api.maple.dev", token: "secret" }
		expect(storedTokenFor(stored, "https://api.maple.dev")).toBe("secret")
		expect(storedTokenFor(stored, "https://api.maple.dev/")).toBe("secret")
		expect(storedTokenFor(stored, "https://evil.example.test")).toBeUndefined()
		expect(storedTokenFor(stored, "http://api.maple.dev")).toBeUndefined()
		expect(storedTokenFor(stored, "not a url")).toBeUndefined()
		expect(storedTokenFor({ token: "secret" }, "https://api.maple.dev")).toBeUndefined()
	})
})
