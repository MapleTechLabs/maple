import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Array as Arr, Effect, Layer, Option, String as Str } from "effect"
import { FetchHttpClient } from "effect/http"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { canPrepend, debugIdFor, debugIdSnippet, existingDebugId, injectDirectory } from "./sourcemaps"
import { uploadDirectory } from "./sourcemaps-upload"

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

const DIGITS = new Map(
	Arr.map(
		Arr.fromIterable("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"),
		(c, i) => [c, i] as const,
	),
)

/** The original (0-based) line the first segment of generated line `line` (1-based) maps to. */
const originalLineAt = (mappings: string, line: number): number | undefined => {
	const decode = (segment: string): ReadonlyArray<number> => {
		const values: Array<number> = []
		const state = { value: 0, shift: 0 }
		Arr.forEach(Arr.fromIterable(segment), (char) => {
			const digit = DIGITS.get(char) ?? 0
			state.value += (digit & 31) << state.shift
			state.shift += 5
			if ((digit & 32) === 0) {
				values.push((state.value & 1) === 1 ? -(state.value >>> 1) : state.value >>> 1)
				state.value = 0
				state.shift = 0
			}
		})
		return values
	}
	// Source lines are deltas across the whole mappings string.
	const lines = Str.split(";")(mappings)
	const sourceLine = { value: 0 }
	const found = { value: undefined as number | undefined }
	Arr.forEach(lines, (generated, i) => {
		Arr.forEach(generated === "" ? [] : Str.split(",")(generated), (segment, j) => {
			const fields = decode(segment)
			sourceLine.value += fields[2] ?? 0
			if (i === line - 1 && j === 0) found.value = sourceLine.value
		})
	})
	return found.value
}

describe("debugIdFor", () => {
	test("is a lowercase UUID of the JS and its map, never of the map's own debug id", () => {
		const id = debugIdFor("console.log(1)\n", map("a.js"))
		expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
		expect(debugIdFor("console.log(1)\n", map("a.js"))).toBe(id)
		expect(debugIdFor("console.log(2)\n", map("a.js"))).not.toBe(id)
		expect(debugIdFor("console.log(1)\n", map("a.js", { debugId: id, debug_id: id }))).toBe(id)
	})
})

describe("injectDirectory", () => {
	test("registers first, tags the end and shifts the map one line", async () => {
		mkdirSync(join(dir, "assets"))
		const withUrl = "function a(){return 1}\n//# sourceMappingURL=index.js.map\n"
		const bare = "export const b=2;"
		writeFileSync(join(dir, "assets/index.js"), withUrl)
		writeFileSync(join(dir, "assets/index.js.map"), map("index.js", { mappings: "AAAA;AACA" }))
		writeFileSync(join(dir, "chunk.mjs"), bare)
		writeFileSync(join(dir, "chunk.mjs.map"), map("chunk.mjs"))
		writeFileSync(join(dir, "nomap.cjs"), "module.exports=1\n")

		const results = await run(injectDirectory(dir, { dryRun: false }))

		const idA = debugIdFor(withUrl, map("index.js", { mappings: "AAAA;AACA" }))
		const idB = debugIdFor(bare, map("chunk.mjs"))
		expect(read(join(dir, "assets/index.js"))).toBe(
			`${debugIdSnippet(idA)}\nfunction a(){return 1}\n//# debugId=${idA}\n//# sourceMappingURL=index.js.map\n`,
		)
		expect(read(join(dir, "chunk.mjs"))).toBe(
			`${debugIdSnippet(idB)}\nexport const b=2;\n//# debugId=${idB}\n`,
		)
		expect(read(join(dir, "nomap.cjs"))).toBe("module.exports=1\n")

		const mapA = JSON.parse(read(join(dir, "assets/index.js.map")))
		expect(mapA).toEqual({
			...JSON.parse(map("index.js")),
			mappings: ";AAAA;AACA",
			debugId: idA,
			debug_id: idA,
		})
		// `function a` was generated line 1 (original line 0) and is line 2 now; the next line follows.
		expect([originalLineAt("AAAA;AACA", 1), originalLineAt("AAAA;AACA", 2)]).toEqual([0, 1])
		expect([
			originalLineAt(mapA.mappings, 1),
			originalLineAt(mapA.mappings, 2),
			originalLineAt(mapA.mappings, 3),
		]).toEqual([undefined, 0, 1])

		expect(Arr.map(results, (r) => [r.file, r.status])).toEqual([
			["assets/index.js", "injected"],
			["chunk.mjs", "injected"],
			["nomap.cjs", "no_map"],
		])
	})

	test("appends after a shebang, a directive prologue or for an index map, leaving mappings alone", async () => {
		const shebang = "#!/usr/bin/env node\nrun()\n"
		const strict = '/*! license */\n"use strict";\nrun()\n'
		const single = "'use client';\nrun()\n"
		const indexed = "run()\n"
		const sections = {
			mappings: undefined,
			sections: [{ offset: { line: 0, column: 0 }, map: JSON.parse(map("i.js")) }],
		}
		writeFileSync(join(dir, "a.js"), shebang)
		writeFileSync(join(dir, "a.js.map"), map("a.js"))
		writeFileSync(join(dir, "b.js"), strict)
		writeFileSync(join(dir, "b.js.map"), map("b.js"))
		writeFileSync(join(dir, "c.js"), single)
		writeFileSync(join(dir, "c.js.map"), map("c.js"))
		writeFileSync(join(dir, "i.js"), indexed)
		writeFileSync(join(dir, "i.js.map"), map("i.js", sections))

		const results = await run(injectDirectory(dir, { dryRun: false }))
		const ids = Arr.map(results, (r) => Option.getOrElse(r.debugId, () => ""))
		Arr.forEach([shebang, strict, single, indexed], (code, i) => {
			const file = ["a.js", "b.js", "c.js", "i.js"][i] ?? ""
			const id = ids[i] ?? ""
			expect(read(join(dir, file))).toBe(`${code}${debugIdSnippet(id)}\n//# debugId=${id}\n`)
		})
		expect(JSON.parse(read(join(dir, "a.js.map"))).mappings).toBe("AAAA,SAAS;AACT")
		expect(JSON.parse(read(join(dir, "i.js.map"))).sections).toHaveLength(1)

		const again = await run(injectDirectory(dir, { dryRun: false }))
		expect(Arr.map(again, (r) => [r.status, r.mapUpdated])).toEqual(
			Arr.makeBy(4, () => ["already_injected", false]),
		)
	})

	test("reads a directive prologue past comments in one linear pass", () => {
		expect(canPrepend('/*! a */\n// b\n  "use strict";\nrun()')).toBe(false)
		expect(canPrepend("/* a */ run('x')")).toBe(true)
		const started = performance.now()
		canPrepend(Str.repeat(100_000)("/*"))
		canPrepend(`${Str.repeat(100_000)(" ")}x`)
		expect(performance.now() - started).toBeLessThan(50)
	})

	test("gives identical JS with different maps different ids", async () => {
		mkdirSync(join(dir, "r1"))
		mkdirSync(join(dir, "r2"))
		const code = "throwIt()\n"
		writeFileSync(join(dir, "r1/a.js"), code)
		writeFileSync(join(dir, "r1/a.js.map"), map("a.js", { mappings: "AAAA" }))
		writeFileSync(join(dir, "r2/a.js"), code)
		writeFileSync(join(dir, "r2/a.js.map"), map("a.js", { mappings: "AACA" }))

		const [first] = await run(injectDirectory(join(dir, "r1"), { dryRun: false }))
		const [second] = await run(injectDirectory(join(dir, "r2"), { dryRun: false }))
		expect(Option.getOrNull(first?.debugId ?? Option.none())).not.toBe(
			Option.getOrNull(second?.debugId ?? Option.none()),
		)
	})

	test("never writes an id into a map two files share, and uploads it once per file", async () => {
		mkdirSync(join(dir, "maps"))
		writeFileSync(join(dir, "app.js"), "a()\n//# sourceMappingURL=maps/app.map\n")
		writeFileSync(join(dir, "app-legacy.js"), "b()\n//# sourceMappingURL=maps/app.map\n")
		writeFileSync(join(dir, "maps/app.map"), map("app.js"))

		const results = await run(injectDirectory(dir, { dryRun: false }))
		expect(read(join(dir, "maps/app.map"))).toBe(map("app.js"))
		const ids = Arr.map(results, (r) => Option.getOrNull(r.debugId))
		expect(ids[0]).not.toBe(ids[1])
		// The lines did not move: the snippet went after the code.
		expect(Str.startsWith("b()\n")(read(join(dir, "app-legacy.js")))).toBe(true)

		const seen: Array<URLSearchParams> = []
		const server = Bun.serve({
			port: 0,
			fetch: (request) => {
				seen.push(new URL(request.url).searchParams)
				return Response.json({ id: "smap_1" })
			},
		})
		const outcomes = await Effect.runPromise(
			uploadDirectory(
				dir,
				{
					apiUrl: `http://127.0.0.1:${server.port}`,
					token: "t",
					service: Option.none(),
					version: Option.none(),
					urlPrefix: Option.none(),
					concurrency: 1,
				},
				() => Effect.void,
			).pipe(Effect.provide(Layer.merge(FetchHttpClient.layer, BunServices.layer))),
		)
		await server.stop(true)
		expect(Arr.map(outcomes, (o) => o._tag)).toEqual(["uploaded", "uploaded"])
		// Each file is uploaded under its own path with the id its own snippet registers.
		expect(Arr.map(seen, (params) => [params.get("minified_path"), params.get("debug_id")])).toEqual(
			Arr.map(results, (r) => [r.file, Option.getOrNull(r.debugId)]),
		)
	})

	test("refuses a map outside the build directory, by path or by symlink", async () => {
		const build = join(dir, "dist")
		mkdirSync(build)
		const outside = join(dir, "secret.json")
		writeFileSync(outside, JSON.stringify({ version: 3, sources: ["x"], mappings: "AAAA" }))
		writeFileSync(join(build, "up.js"), "u()\n//# sourceMappingURL=../secret.json\n")
		writeFileSync(join(build, "abs.js"), `v()\n//# sourceMappingURL=${outside}\n`)
		writeFileSync(join(build, "link.js"), "w()\n")
		symlinkSync(outside, join(build, "link.js.map"))
		writeFileSync(join(build, "pkg.js"), "p()\n")
		writeFileSync(join(build, "pkg.js.map"), JSON.stringify({ name: "not-a-map" }))

		const results = await run(injectDirectory(build, { dryRun: false }))

		expect(Arr.map(results, (r) => [r.file, r.status])).toEqual([
			["abs.js", "unsafe_map"],
			["link.js", "unsafe_map"],
			["pkg.js", "invalid_map"],
			["up.js", "unsafe_map"],
		])
		expect(read(outside)).toBe(JSON.stringify({ version: 3, sources: ["x"], mappings: "AAAA" }))
		expect(read(join(build, "pkg.js.map"))).toBe(JSON.stringify({ name: "not-a-map" }))
		expect(read(join(build, "up.js"))).toBe("u()\n//# sourceMappingURL=../secret.json\n")
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
		expect(existingDebugId(zAfterFirst)).toEqual(Option.some(debugIdFor("z()\n", map("z.js"))))
	})

	test("keeps the id a runtime registration carries without a comment", async () => {
		const existing = "0b1c2d3e-4f50-4617-8899-aabbccddeeff"
		const registered = `${debugIdSnippet(existing)}\nr()\n`
		writeFileSync(join(dir, "r.js"), registered)
		writeFileSync(join(dir, "r.js.map"), map("r.js"))

		const [result] = await run(injectDirectory(dir, { dryRun: false }))

		expect(Option.getOrNull(result?.debugId ?? Option.none())).toBe(existing)
		expect(read(join(dir, "r.js"))).toBe(registered)
		expect(JSON.parse(read(join(dir, "r.js.map"))).debugId).toBe(existing)
	})

	test("registers a bundler's bare debugId comment at runtime, reusing its id", async () => {
		const existing = "0b1c2d3e-4f50-4617-8899-aabbccddeeff"
		// Rollup/Vite `sourcemapDebugIds` output: the comment, nothing that runs.
		const v = `v()\n//# debugId=${existing}\n//# sourceMappingURL=v.js.map\n`
		writeFileSync(join(dir, "v.js"), v)
		writeFileSync(join(dir, "v.js.map"), map("v.js"))
		writeFileSync(join(dir, "w.js"), `w()\n//# debugId=${existing}\n//# sourceMappingURL=w.js.map\n`)
		writeFileSync(join(dir, "w.js.map"), map("w.js", { debugId: existing }))

		const results = await run(injectDirectory(dir, { dryRun: false }))

		expect(read(join(dir, "v.js"))).toBe(`${debugIdSnippet(existing)}\n${v}`)
		const vMap = JSON.parse(read(join(dir, "v.js.map")))
		expect([vMap.debugId, vMap.debug_id, vMap.mappings]).toEqual([existing, existing, ";AAAA,SAAS;AACT"])
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
		expect(JSON.parse(read(join(dir, "v.js.map"))).mappings).toBe(";AAAA,SAAS;AACT")
	})

	test("does not take a bundled SDK reading the debug id map for this file's registration", async () => {
		const existing = "0b1c2d3e-4f50-4617-8899-aabbccddeeff"
		const sdk = "var o=owner._mapleDebugIds||owner._sentryDebugIds;o&&(ids[o[k]]=k);"
		const code = `${sdk}\n//# debugId=${existing}\n//# sourceMappingURL=sdk.js.map\n`
		writeFileSync(join(dir, "sdk.js"), code)
		writeFileSync(join(dir, "sdk.js.map"), map("sdk.js"))

		const [result] = await run(injectDirectory(dir, { dryRun: false }))

		expect(result?.status).toBe("injected")
		expect(read(join(dir, "sdk.js"))).toBe(`${debugIdSnippet(existing)}\n${code}`)
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

		const idC = debugIdFor(crlf, map("c.js"))
		const idD = debugIdFor(noNewline, map("d.js"))
		expect(read(join(dir, "c.js"))).toBe(
			`${debugIdSnippet(idC)}\nc()\r\n//# debugId=${idC}\n//# sourceMappingURL=c.js.map\r\n`,
		)
		expect(read(join(dir, "d.js"))).toBe(
			`${debugIdSnippet(idD)}\nd()\n//# debugId=${idD}\n//# sourceMappingURL=d.js.map`,
		)
		expect(read(join(dir, "e.js"))).toBe(`${debugIdSnippet(existing)}\n${crlfBare}`)
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
