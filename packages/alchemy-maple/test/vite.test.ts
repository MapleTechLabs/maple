import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { originalPositionFor, TraceMap } from "@jridgewell/trace-mapping"
import { Array as Arr, Effect, Option, Order, Result, Schema, String as Str } from "effect"
import { SourceMapsManifest } from "@maple/sourcemaps"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { build } from "vite"
import { mapleSourceMaps, processBuildOutputs } from "../src/Vite"
import * as NodeServices from "@effect/platform-node/NodeServices"

const decodeManifest = Schema.decodeUnknownSync(Schema.fromJsonString(SourceMapsManifest))

const SOURCE = Arr.join(
	[
		"export function thrower(x) {",
		"  if (x > 1) {",
		'    throw new Error("boom-from-line-3")',
		"  }",
		"  return x",
		"}",
		"console.log(thrower(Math.random()))",
		"",
	],
	"\n",
)

const walk = (dir: string): ReadonlyArray<string> =>
	Arr.flatMap(readdirSync(dir, { withFileTypes: true }), (entry) =>
		entry.isDirectory()
			? Arr.map(walk(join(dir, entry.name)), (f) => `${entry.name}/${f}`)
			: [entry.name],
	)

let root = ""
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "maple-vite-"))
	mkdirSync(join(root, "src"))
	writeFileSync(join(root, "src/main.js"), SOURCE)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe("mapleSourceMaps", () => {
	it("injects debug ids and moves every map out of the output, still mapping to the source", async () => {
		await build({
			root,
			configFile: false,
			logLevel: "silent",
			plugins: [mapleSourceMaps()],
			build: { outDir: "dist", rolldownOptions: { input: join(root, "src/main.js") } },
		})

		const output = walk(join(root, "dist"))
		expect(Arr.filter(output, Str.endsWith(".map"))).toEqual([])
		const [jsFile] = Arr.filter(output, Str.endsWith(".js"))
		expect(jsFile).toBeDefined()
		const code = readFileSync(join(root, "dist", jsFile ?? ""), "utf8")
		expect(code).toContain("_mapleDebugIds")
		const debugId = /\/\/# debugId=([0-9a-f-]{36})/.exec(code)?.[1]
		expect(debugId).toBeDefined()
		expect(code).not.toContain("sourceMappingURL")

		const mapsDir = join(root, ".maple/sourcemaps/dist")
		const manifest = JSON.parse(readFileSync(join(mapsDir, "maple-sourcemaps.json"), "utf8"))
		expect(manifest).toEqual({ version: 1, files: [{ file: jsFile, debugId, map: `${jsFile}.map` }] })
		const map = JSON.parse(readFileSync(join(mapsDir, `${jsFile}.map`), "utf8"))
		expect([map.debugId, map.debug_id, map.x_maple_shifted]).toEqual([debugId, debugId, debugId])
		expect(Str.startsWith(";")(map.mappings)).toBe(true)

		// The thrown message's generated position still maps to line 3 of the source.
		const lines = Str.split("\n")(code)
		const line = Arr.findFirstIndex(lines, Str.includes("boom-from-line-3"))
		expect(line._tag).toBe("Some")
		const generatedLine = line._tag === "Some" ? line.value : -1
		const column = Option.getOrElse(Str.indexOf("boom-from-line-3")(lines[generatedLine] ?? ""), () => -1)
		const position = originalPositionFor(new TraceMap(map), { line: generatedLine + 1, column })
		expect([Str.endsWith("src/main.js")(position.source ?? ""), position.line]).toEqual([true, 3])
	})

	it("relocates every output of a build that writes several into one dir", async () => {
		await build({
			root,
			configFile: false,
			logLevel: "silent",
			plugins: [mapleSourceMaps({ mapsDir: "maps" })],
			build: {
				outDir: "dist",
				rolldownOptions: {
					input: join(root, "src/main.js"),
					output: [
						{ dir: join(root, "dist"), entryFileNames: "esm-[name].js", format: "es" },
						{ dir: join(root, "dist"), entryFileNames: "cjs-[name].js", format: "cjs" },
					],
				},
			},
		})
		const output = walk(join(root, "dist"))
		expect(Arr.filter(output, Str.endsWith(".map"))).toEqual([])
		const manifest = decodeManifest(readFileSync(join(root, "maps/maple-sourcemaps.json"), "utf8"))
		expect(
			Arr.sort(
				Arr.map(manifest.files, (file) => file.file),
				Order.String,
			),
		).toEqual(["cjs-main.js", "esm-main.js"])
		expect(Arr.sort(Arr.filter(walk(join(root, "maps")), Str.endsWith(".map")), Order.String)).toEqual([
			"cjs-main.js.map",
			"esm-main.js.map",
		])
	})
})

describe("processBuildOutputs", () => {
	const writeOutput = (dir: string) => {
		mkdirSync(dir, { recursive: true })
		writeFileSync(join(dir, "a.js"), "a()\n")
		writeFileSync(
			join(dir, "a.js.map"),
			JSON.stringify({ version: 3, sources: ["a.ts"], mappings: "AAAA" }),
		)
	}
	const run = (outDirs: ReadonlyArray<string>, mapsDir: string) =>
		Effect.runPromise(
			Effect.result(processBuildOutputs(outDirs, mapsDir)).pipe(Effect.provide(NodeServices.layer)),
		)

	it("refuses a maps dir that is, holds or sits inside the output, touching nothing", async () => {
		const dist = join(root, "dist")
		writeOutput(dist)
		for (const mapsDir of [dist, join(dist, "maps"), root]) {
			const result = await run([dist], mapsDir)
			expect(Result.isFailure(result) ? result.failure._tag : "ok").toBe(
				"@maple/sourcemaps/SourceMapsDirOverlapError",
			)
		}
		expect(Arr.sort(walk(dist), Order.String)).toEqual(["a.js", "a.js.map"])
	})

	it("replaces only the previous build's maps, leaving other files in the maps dir", async () => {
		const dist = join(root, "dist")
		const maps = join(root, "maps")
		mkdirSync(maps)
		writeFileSync(join(maps, "keep.txt"), "mine")
		writeOutput(dist)
		await run([dist], maps)
		expect(Arr.sort(walk(maps), Order.String)).toEqual(["a.js.map", "keep.txt", "maple-sourcemaps.json"])
		// The next build no longer emits a.js: its map goes, the unrelated file stays.
		rmSync(dist, { recursive: true, force: true })
		mkdirSync(dist)
		writeFileSync(join(dist, "b.js"), "b()\n")
		writeFileSync(
			join(dist, "b.js.map"),
			JSON.stringify({ version: 3, sources: ["b.ts"], mappings: "AAAA" }),
		)
		await run([dist], maps)
		expect(Arr.sort(walk(maps), Order.String)).toEqual(["b.js.map", "keep.txt", "maple-sourcemaps.json"])
	})
})
