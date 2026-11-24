import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Array as Arr, Effect, Option } from "effect"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { debugIdFor, debugIdSnippet, existingDebugId, injectDirectory } from "./sourcemaps"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
	Effect.runPromise(Effect.provide(effect, BunServices.layer))

const map = (file: string, extra: Record<string, unknown> = {}) =>
	JSON.stringify({
		version: 3,
		file,
		sources: ["../src/a.ts"],
		names: [],
		mappings: "AAAA,SAAS;AACT",
		...extra,
	})

const read = (path: string) => readFileSync(path, "utf8")

let dir = ""
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "maple-sourcemaps-"))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("debugIdFor", () => {
	test("is a lowercase UUID that depends only on the content", () => {
		const id = debugIdFor("console.log(1)\n")
		expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
		expect(debugIdFor("console.log(1)\n")).toBe(id)
		expect(debugIdFor("console.log(2)\n")).not.toBe(id)
	})
})

describe("injectDirectory", () => {
	test("appends the snippet and comment, before an existing sourceMappingURL, and tags the map", async () => {
		mkdirSync(join(dir, "assets"))
		const withUrl = "function a(){return 1}\n//# sourceMappingURL=index.js.map\n"
		const bare = "export const b=2;"
		writeFileSync(join(dir, "assets/index.js"), withUrl)
		writeFileSync(join(dir, "assets/index.js.map"), map("index.js"))
		writeFileSync(join(dir, "chunk.mjs"), bare)
		writeFileSync(join(dir, "chunk.mjs.map"), map("chunk.mjs"))
		writeFileSync(join(dir, "nomap.cjs"), "module.exports=1\n")

		const results = await run(injectDirectory(dir, { dryRun: false }))

		const idA = debugIdFor(withUrl)
		const idB = debugIdFor(bare)
		expect(read(join(dir, "assets/index.js"))).toBe(
			`function a(){return 1}\n${debugIdSnippet(idA)}\n//# debugId=${idA}\n//# sourceMappingURL=index.js.map\n`,
		)
		expect(read(join(dir, "chunk.mjs"))).toBe(
			`export const b=2;\n${debugIdSnippet(idB)}\n//# debugId=${idB}\n`,
		)
		expect(read(join(dir, "nomap.cjs"))).toBe("module.exports=1\n")

		const mapA = JSON.parse(read(join(dir, "assets/index.js.map")))
		expect(mapA).toEqual({ ...JSON.parse(map("index.js")), debugId: idA, debug_id: idA })
		expect(mapA.mappings).toBe("AAAA,SAAS;AACT")

		expect(Arr.map(results, (r) => [r.file, r.status])).toEqual([
			["assets/index.js", "injected"],
			["chunk.mjs", "injected"],
			["nomap.cjs", "no_map"],
		])
	})

	test("follows a sourceMappingURL to a map with another name", async () => {
		mkdirSync(join(dir, "maps"))
		writeFileSync(join(dir, "app.js"), "x()\n//# sourceMappingURL=maps/app.map\n")
		writeFileSync(join(dir, "maps/app.map"), map("app.js"))

		const [result] = await run(injectDirectory(dir, { dryRun: false }))

		expect(result?.status).toBe("injected")
		expect(JSON.parse(read(join(dir, "maps/app.map"))).debugId).toBe(
			Option.getOrNull(result?.debugId ?? Option.none()),
		)
	})

	test("keeps an existing registered debug id and is a no-op on a second run", async () => {
		const existing = "0b1c2d3e-4f50-4617-8899-aabbccddeeff"
		const injected = `y()\n${debugIdSnippet(existing)}\n//# debugId=${existing}\n//# sourceMappingURL=y.js.map\n`
		writeFileSync(join(dir, "y.js"), injected)
		writeFileSync(join(dir, "y.js.map"), map("y.js"))
		writeFileSync(join(dir, "z.js"), "z()\n")
		writeFileSync(join(dir, "z.js.map"), map("z.js"))

		const first = await run(injectDirectory(dir, { dryRun: false }))
		expect(read(join(dir, "y.js"))).toBe(injected)
		expect(JSON.parse(read(join(dir, "y.js.map"))).debug_id).toBe(existing)
		expect(Arr.map(first, (r) => r.status)).toEqual(["already_injected", "injected"])

		const zAfterFirst = read(join(dir, "z.js"))
		const zMapAfterFirst = read(join(dir, "z.js.map"))
		const second = await run(injectDirectory(dir, { dryRun: false }))
		expect(Arr.map(second, (r) => [r.status, r.mapUpdated])).toEqual([
			["already_injected", false],
			["already_injected", false],
		])
		expect(read(join(dir, "z.js"))).toBe(zAfterFirst)
		expect(read(join(dir, "z.js.map"))).toBe(zMapAfterFirst)
		expect(existingDebugId(zAfterFirst)).toEqual(Option.some(debugIdFor("z()\n")))
	})

	test("registers a bundler's bare debugId comment at runtime, reusing its id", async () => {
		const existing = "0b1c2d3e-4f50-4617-8899-aabbccddeeff"
		// Rollup/Vite `sourcemapDebugIds` output: the comment, nothing that runs.
		writeFileSync(join(dir, "v.js"), `v()\n//# debugId=${existing}\n//# sourceMappingURL=v.js.map\n`)
		writeFileSync(join(dir, "v.js.map"), map("v.js"))
		writeFileSync(join(dir, "w.js"), `w()\n//# debugId=${existing}\n//# sourceMappingURL=w.js.map\n`)
		writeFileSync(join(dir, "w.js.map"), map("w.js", { debugId: existing }))

		const results = await run(injectDirectory(dir, { dryRun: false }))

		expect(read(join(dir, "v.js"))).toBe(
			`v()\n${debugIdSnippet(existing)}\n//# debugId=${existing}\n//# sourceMappingURL=v.js.map\n`,
		)
		const vMap = JSON.parse(read(join(dir, "v.js.map")))
		expect([vMap.debugId, vMap.debug_id]).toEqual([existing, existing])
		expect(Arr.map(results, (r) => [r.file, r.status, Option.getOrNull(r.debugId)])).toEqual([
			["v.js", "injected", existing],
			["w.js", "injected", existing],
		])
		expect(JSON.parse(read(join(dir, "w.js.map"))).debug_id).toBe(existing)

		const again = await run(injectDirectory(dir, { dryRun: false }))
		expect(Arr.map(again, (r) => [r.status, r.mapUpdated])).toEqual([
			["already_injected", false],
			["already_injected", false],
		])
	})

	test("does not take a bundled SDK reading the debug id map for this file's registration", async () => {
		const existing = "0b1c2d3e-4f50-4617-8899-aabbccddeeff"
		const sdk = "var o=owner._mapleDebugIds||owner._sentryDebugIds;o&&(ids[o[k]]=k);"
		const code = `${sdk}\n//# debugId=${existing}\n//# sourceMappingURL=sdk.js.map\n`
		writeFileSync(join(dir, "sdk.js"), code)
		writeFileSync(join(dir, "sdk.js.map"), map("sdk.js"))

		const [result] = await run(injectDirectory(dir, { dryRun: false }))

		expect(result?.status).toBe("injected")
		expect(read(join(dir, "sdk.js"))).toBe(
			`${sdk}\n${debugIdSnippet(existing)}\n//# debugId=${existing}\n//# sourceMappingURL=sdk.js.map\n`,
		)
		const [again] = await run(injectDirectory(dir, { dryRun: false }))
		expect(again?.status).toBe("already_injected")
	})

	test("handles CRLF line endings and a missing trailing newline", async () => {
		const crlf = "c()\r\n//# sourceMappingURL=c.js.map\r\n"
		const noNewline = "d()\n//# sourceMappingURL=d.js.map"
		const existing = "0b1c2d3e-4f50-4617-8899-aabbccddeeff"
		const crlfBare = `e()\r\n//# debugId=${existing}\r\n//# sourceMappingURL=e.js.map`
		writeFileSync(join(dir, "c.js"), crlf)
		writeFileSync(join(dir, "c.js.map"), map("c.js"))
		writeFileSync(join(dir, "d.js"), noNewline)
		writeFileSync(join(dir, "d.js.map"), map("d.js"))
		writeFileSync(join(dir, "e.js"), crlfBare)
		writeFileSync(join(dir, "e.js.map"), map("e.js"))

		const results = await run(injectDirectory(dir, { dryRun: false }))

		const idC = debugIdFor(crlf)
		const idD = debugIdFor(noNewline)
		expect(read(join(dir, "c.js"))).toBe(
			`c()\r\n${debugIdSnippet(idC)}\n//# debugId=${idC}\n//# sourceMappingURL=c.js.map\r\n`,
		)
		expect(read(join(dir, "d.js"))).toBe(
			`d()\n${debugIdSnippet(idD)}\n//# debugId=${idD}\n//# sourceMappingURL=d.js.map`,
		)
		expect(read(join(dir, "e.js"))).toBe(
			`e()\r\n${debugIdSnippet(existing)}\n//# debugId=${existing}\r\n//# sourceMappingURL=e.js.map`,
		)
		expect(Arr.map(results, (r) => Option.getOrNull(r.debugId))).toEqual([idC, idD, existing])
	})

	test("--dry-run reports the change and writes nothing", async () => {
		writeFileSync(join(dir, "a.js"), "a()\n")
		writeFileSync(join(dir, "a.js.map"), map("a.js"))

		const [result] = await run(injectDirectory(dir, { dryRun: true }))

		expect(result?.status).toBe("injected")
		expect(read(join(dir, "a.js"))).toBe("a()\n")
		expect(read(join(dir, "a.js.map"))).toBe(map("a.js"))
	})
})
