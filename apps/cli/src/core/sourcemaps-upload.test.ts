import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Array as Arr, Effect, Layer, Option, Record as Rec } from "effect"
import { FetchHttpClient } from "effect/http"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { minifiedPathFor, uploadDirectory, type UploadOptions, type UploadOutcome } from "./sourcemaps-upload"

interface Seen {
	readonly url: URL
	readonly authorization: string | null
	readonly contentType: string | null
	readonly body: string
}

const servers: Array<ReturnType<typeof Bun.serve>> = []

/** A local stand-in for `POST /v2/source_maps`, reached over the real fetch client. */
const fakeServer = (answer: (url: URL) => Response) => {
	const seen: Array<Seen> = []
	const server = Bun.serve({
		port: 0,
		fetch: async (request) => {
			const url = new URL(request.url)
			seen.push({
				url,
				authorization: request.headers.get("authorization"),
				contentType: request.headers.get("content-type"),
				body: await request.text(),
			})
			return answer(url)
		},
	})
	servers.push(server)
	return { seen, apiUrl: `http://127.0.0.1:${server.port}/` }
}

const options = (overrides: Partial<UploadOptions> = {}): UploadOptions => ({
	apiUrl: "http://127.0.0.1:1/",
	token: "maple_ak_test",
	service: Option.none(),
	version: Option.none(),
	urlPrefix: Option.none(),
	concurrency: 4,
	...overrides,
})

const upload = (dir: string, opts: UploadOptions) =>
	Effect.runPromise(
		uploadDirectory(dir, opts, () => Effect.void).pipe(
			Effect.provide(Layer.merge(FetchHttpClient.layer, BunServices.layer)),
		),
	)

const ID = "0b1c2d3e-4f50-4617-8899-aabbccddeeff"
const mapWithId = JSON.stringify({ version: 3, sources: [], names: [], mappings: "AAAA", debugId: ID })

let dir = ""
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "maple-sourcemaps-upload-"))
})
afterEach(async () => {
	rmSync(dir, { recursive: true, force: true })
	await Promise.all(Arr.map(servers.splice(0), (server) => server.stop(true)))
})

describe("minifiedPathFor", () => {
	test("prepends the prefix with one slash and never starts with one", () => {
		expect(minifiedPathFor(Option.some("assets/"), "index.js")).toBe("assets/index.js")
		expect(minifiedPathFor(Option.some("/static"), "js/a.js")).toBe("static/js/a.js")
		expect(minifiedPathFor(Option.none(), "a.js")).toBe("a.js")
	})
})

describe("uploadDirectory", () => {
	test("posts each map as the raw body with its path, debug id, service and version", async () => {
		mkdirSync(join(dir, "js"))
		writeFileSync(join(dir, "js/index-Bx81.js"), `a()\n//# debugId=${ID}\n`)
		writeFileSync(join(dir, "js/index-Bx81.js.map"), mapWithId)
		writeFileSync(join(dir, "orphan.js.map"), mapWithId)
		const server = fakeServer(() =>
			Response.json({ object: "source_map", id: "smap_1" }, { status: 201 }),
		)

		const outcomes = await upload(
			dir,
			options({
				apiUrl: server.apiUrl,
				service: Option.some("web"),
				version: Option.some("abc123"),
				urlPrefix: Option.some("assets/"),
			}),
		)

		expect(server.seen).toHaveLength(1)
		const call = server.seen[0]
		expect(call?.url.pathname).toBe("/v2/source_maps")
		expect(Rec.fromEntries(Arr.fromIterable(call?.url.searchParams ?? []))).toEqual({
			minified_path: "assets/js/index-Bx81.js",
			debug_id: ID,
			service: "web",
			version: "abc123",
		})
		expect(call?.authorization).toBe("Bearer maple_ak_test")
		expect(call?.body).toBe(mapWithId)
		expect(call?.contentType).toBe("application/json")
		expect(outcomes).toEqual([
			{
				_tag: "uploaded",
				minifiedPath: "assets/js/index-Bx81.js",
				debugId: Option.some(ID),
				sizeBytes: mapWithId.length,
				id: Option.some("smap_1"),
			},
		])
	})

	test("reads the debug id from the JS comment when the map has none", async () => {
		writeFileSync(join(dir, "a.js"), `a()\n//# debugId=${ID}\n`)
		writeFileSync(join(dir, "a.js.map"), JSON.stringify({ version: 3, mappings: "" }))
		const server = fakeServer(() => Response.json({ id: "smap_2" }))

		await upload(dir, options({ apiUrl: server.apiUrl }))

		expect(server.seen[0]?.url.searchParams.get("debug_id")).toBe(ID)
		expect(server.seen[0]?.url.searchParams.has("service")).toBe(false)
	})

	test("a refused upload carries the server's message and the rest still upload", async () => {
		writeFileSync(join(dir, "bad.js"), "b()\n")
		writeFileSync(join(dir, "bad.js.map"), JSON.stringify({ version: 3, mappings: "" }))
		writeFileSync(join(dir, "good.js"), "g()\n")
		writeFileSync(join(dir, "good.js.map"), mapWithId)
		const server = fakeServer((url) =>
			url.searchParams.get("minified_path") === "bad.js"
				? Response.json({ error: { message: "mappings must be a string" } }, { status: 400 })
				: Response.json({ id: "smap_3" }),
		)

		const outcomes = await upload(
			dir,
			options({ apiUrl: server.apiUrl, service: Option.some("web"), version: Option.some("v1") }),
		)

		const byPath = Rec.fromEntries(Arr.map(outcomes, (o: UploadOutcome) => [o.minifiedPath, o] as const))
		const bad = byPath["bad.js"]
		expect(bad?._tag).toBe("failed")
		if (bad?._tag === "failed") {
			expect(bad.error.status).toBe(400)
			expect(bad.error.message).toBe("HTTP 400: mappings must be a string")
		}
		expect(byPath["good.js"]?._tag).toBe("uploaded")
	})

	test("skips a map with no debug id when there is no service and release to match it by", async () => {
		writeFileSync(join(dir, "a.js"), "a()\n")
		writeFileSync(join(dir, "a.js.map"), JSON.stringify({ version: 3, mappings: "" }))
		const server = fakeServer(() => Response.json({ id: "smap_4" }))

		const outcomes = await upload(dir, options({ apiUrl: server.apiUrl, service: Option.some("web") }))

		expect(server.seen).toHaveLength(0)
		expect(Arr.map(outcomes, (o) => o._tag)).toEqual(["skipped"])
	})
})
