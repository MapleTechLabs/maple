import { describe, expect, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Core from "@alchemy.run/test/Core"
import * as Provider from "alchemy/Provider"
import * as State from "alchemy/State"
import { Array as Arr, Effect, Layer, Option, Record as Rec, String as Str } from "effect"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MapleApi, type MapleApiContract } from "../src/MapleApi"
import { Providers } from "../src/Providers"
import { SourceMaps, SourceMapsProvider } from "../src/SourceMaps"
import { processBuildOutputs } from "../src/Vite"
import { SourceMapsManifest } from "@maple/sourcemaps"
import { Schema } from "effect"

const decodeManifest = Schema.decodeUnknownSync(Schema.fromJsonString(SourceMapsManifest))
const decodeMap = Schema.decodeUnknownSync(
	Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
)

interface Upload {
	readonly path: string
	readonly query: Readonly<Record<string, string>>
	readonly body: string
	readonly contentType: string
}

const makeHarness = () => {
	const uploads: Array<Upload> = []
	const unexpected = (method: string) => (path: string) => Effect.die(`unexpected ${method} ${path}`)
	const api: MapleApiContract = {
		get: unexpected("GET"),
		post: unexpected("POST"),
		patch: unexpected("PATCH"),
		put: unexpected("PUT"),
		delete: unexpected("DELETE"),
		upload: (path, body, contentType) =>
			Effect.sync(() => {
				const url = new URL(path, "https://maple.test")
				uploads.push({
					path: url.pathname,
					query: Rec.fromEntries(Arr.fromIterable(url.searchParams)),
					body: new TextDecoder().decode(body),
					contentType,
				})
				return { object: "source_map", id: `smap_${uploads.length}` }
			}),
	}
	const providers = Layer.effect(Providers, Provider.collection([SourceMaps])).pipe(
		Layer.provide(SourceMapsProvider()),
		Layer.provide(Layer.succeed(MapleApi, api)),
		Layer.provide(NodeServices.layer),
	)
	const options = { providers, state: State.inMemoryState(), stage: "test", adopt: false, dev: false }
	return {
		uploads,
		stack: (name: string) => Core.scratchStack(options, name),
		run: <A>(effect: Core.TestEffect<A>) => Core.toEffect(effect, options),
	}
}

const map = (source: string) =>
	JSON.stringify({ version: 3, sources: [source], names: [], mappings: "AAAA;AACA" })

/** A built output with two JS files and their maps, processed as the Vite plugin does. */
const buildOutput = (root: string, secondSource = "src/b.ts") =>
	Effect.gen(function* () {
		const dist = join(root, "dist")
		mkdirSync(join(dist, "assets"), { recursive: true })
		writeFileSync(join(dist, "assets/a.js"), "a()\n")
		writeFileSync(join(dist, "assets/a.js.map"), map("src/a.ts"))
		writeFileSync(join(dist, "assets/b.js"), "b()\n")
		writeFileSync(join(dist, "assets/b.js.map"), map(secondSource))
		return yield* processBuildOutputs([dist], join(root, "maps")).pipe(Effect.provide(NodeServices.layer))
	})

describe("Maple.SourceMaps", () => {
	it.live("uploads each map once, and again only when the build changed", () => {
		const h = makeHarness()
		const stack = h.stack("source-maps")
		const root = mkdtempSync(join(tmpdir(), "maple-maps-"))
		const props = { dir: join(root, "maps"), service: "web", release: "abc123", urlPrefix: "static/" }
		return h.run(
			Effect.gen(function* () {
				yield* buildOutput(root)
				const manifest = decodeManifest(
					readFileSync(join(root, "maps/maple-sourcemaps.json"), "utf8"),
				)
				const first = yield* stack.deploy(SourceMaps("maps", props))
				expect(first.uploaded).toBe(2)
				expect(
					Arr.map(h.uploads, (u) => [
						u.path,
						u.query,
						u.contentType,
						u.body ===
							readFileSync(
								join(
									root,
									"maps",
									`${Str.replace("static/", "")(u.query["minified_path"] ?? "")}.map`,
								),
								"utf8",
							),
					]),
				).toEqual(
					Arr.map(manifest.files, (file) => [
						"/v2/source_maps",
						{
							minified_path: `static/${file.file}`,
							service: "web",
							debug_id: file.debugId,
							version: "abc123",
						},
						"application/json",
						true,
					]),
				)
				expect([...first.debugIds].sort()).toEqual(
					Arr.map(manifest.files, (file) => file.debugId).sort(),
				)

				// Unchanged maps: a noop, nothing uploaded.
				h.uploads.length = 0
				expect((yield* stack.plan(SourceMaps("maps", props))).resources.maps?.action).toBe("noop")
				const second = yield* stack.deploy(SourceMaps("maps", props))
				expect([second.digest, h.uploads.length]).toEqual([first.digest, 0])

				// A rebuild that changed a map uploads again.
				yield* buildOutput(root, "src/b-changed.ts")
				const third = yield* stack.deploy(SourceMaps("maps", props))
				expect(third.digest).not.toBe(first.digest)
				expect(h.uploads.length).toBe(2)

				// Deleting uploads and deletes nothing: older releases still need their maps.
				h.uploads.length = 0
				yield* stack.destroy()
				expect(h.uploads).toEqual([])
			}),
		)
	})

	it.live("matched by release, uploads without debug ids, in the query or the map", () => {
		const h = makeHarness()
		const stack = h.stack("by-release")
		const root = mkdtempSync(join(tmpdir(), "maple-maps-"))
		const props = { dir: join(root, "maps"), service: "maple-web", release: "sha-1" }
		return h.run(
			Effect.gen(function* () {
				yield* buildOutput(root)
				const result = yield* stack.deploy(
					SourceMaps("maps", { ...props, matchBy: "release" as const }),
				)
				expect([result.uploaded, result.debugIds]).toEqual([2, []])
				expect(Arr.map(h.uploads, (u) => u.query)).toEqual([
					{ minified_path: "assets/a.js", service: "maple-web", version: "sha-1" },
					{ minified_path: "assets/b.js", service: "maple-web", version: "sha-1" },
				])
				Arr.forEach(h.uploads, (u) => {
					const body = decodeMap(u.body)
					expect(["debugId" in body, "debug_id" in body, body["mappings"]]).toEqual([
						false,
						false,
						";AAAA;AACA",
					])
				})
				// The default keeps the debug ids, so switching mode uploads again.
				h.uploads.length = 0
				yield* stack.deploy(SourceMaps("maps", props))
				expect(Arr.every(h.uploads, (u) => u.query["debug_id"] !== undefined)).toBe(true)
				expect(Arr.every(h.uploads, (u) => "debugId" in decodeMap(u.body))).toBe(true)
			}),
		)
	})

	it.live("reads maps beside their JS without a manifest, skipping ones it cannot match", () => {
		const h = makeHarness()
		const stack = h.stack("plain-dir")
		const root = mkdtempSync(join(tmpdir(), "maple-maps-"))
		writeFileSync(join(root, "main.js"), "m()\n")
		writeFileSync(join(root, "main.js.map"), map("src/main.ts"))
		mkdirSync(join(root, "big"))
		writeFileSync(join(root, "big/huge.js"), "h()\n")
		writeFileSync(
			join(root, "big/huge.js.map"),
			`${Str.slice(0, -1)(map("src/huge.ts"))},"pad":"${Str.repeat(10 * 1024 * 1024)("x")}"}`,
		)
		// A prebuilt worker's map that lists no sources: the server refuses it, so it stays behind.
		writeFileSync(join(root, "worker.js"), "w()\n")
		writeFileSync(
			join(root, "worker.js.map"),
			JSON.stringify({ version: 3, sources: [], names: [], mappings: "" }),
		)
		return h.run(
			Effect.gen(function* () {
				// No release and no debug id: nothing can match the map, so nothing goes up.
				const without = yield* stack.deploy(SourceMaps("maps", { dir: root, service: "api" }))
				expect([without.uploaded, h.uploads.length]).toEqual([0, 0])
				const withRelease = yield* stack.deploy(
					SourceMaps("maps", { dir: root, service: "api", release: "v2" }),
				)
				expect(withRelease.uploaded).toBe(1)
				expect(Arr.map(h.uploads, (u) => u.query)).toEqual([
					{ minified_path: "main.js", service: "api", version: "v2" },
				])
				expect(Option.isNone(Option.fromNullishOr(h.uploads[0]?.query["debug_id"]))).toBe(true)
			}),
		)
	})

	it.live("uploads nothing and keeps its record when the directory is gone", () => {
		const h = makeHarness()
		const stack = h.stack("missing-dir")
		const root = mkdtempSync(join(tmpdir(), "maple-maps-"))
		return h.run(
			Effect.gen(function* () {
				const result = yield* stack.deploy(
					SourceMaps("maps", { dir: join(root, "never-built"), service: "web", release: "1" }),
				)
				expect([result.uploaded, h.uploads.length]).toEqual([0, 0])
			}),
		)
	})
})
