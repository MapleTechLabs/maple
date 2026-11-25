import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Array as Arr, Record as Rec, Schema, String as Str } from "effect"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { build, type InlineConfig, mergeConfig } from "vite"
import { mapleSourceMaps, type MapleSourceMapsOptions } from "../src/index"
import { SourceMapsManifest } from "@maple/sourcemaps"

const decodeManifest = Schema.decodeUnknownSync(Schema.fromJsonString(SourceMapsManifest))

interface Received {
	readonly query: Readonly<Record<string, string>>
	readonly authorization: string | undefined
	readonly body: string
}

const SOURCE = 'export function thrower(x) {\n  throw new Error("boom")\n}\nconsole.log(thrower(1))\n'

let root = ""
let server: Server | undefined
let received: Array<Received> = []
// Status codes the fake API answers with, one per request; 201 once they run out.
let statuses: Array<number> = []

const startApi = () =>
	new Promise<string>((resolve) => {
		server = createServer((req, res) => {
			const chunks: Array<Buffer> = []
			req.on("data", (chunk: Buffer) => chunks.push(chunk))
			req.on("end", () => {
				const url = new URL(req.url ?? "/", "http://localhost")
				received.push({
					query: Rec.fromEntries(Arr.fromIterable(url.searchParams)),
					authorization: req.headers.authorization,
					body: Buffer.concat(chunks).toString("utf8"),
				})
				res.statusCode = statuses.shift() ?? 201
				res.end('{"object":"source_map","id":"smap_1"}')
			})
		})
		const listening = server
		listening.listen(0, "127.0.0.1", () =>
			resolve(`http://127.0.0.1:${(listening.address() as AddressInfo).port}`),
		)
	})

const runBuild = (options: MapleSourceMapsOptions, overrides: InlineConfig = {}) =>
	build(
		mergeConfig(
			{
				root,
				configFile: false,
				logLevel: "silent",
				plugins: [mapleSourceMaps(options)],
				build: { outDir: "dist", rolldownOptions: { input: join(root, "src/main.js") } },
			},
			overrides,
		),
	)

const withEnv = async (env: Readonly<Record<string, string | undefined>>, run: () => Promise<void>) => {
	const previous = Rec.map(env, (_, key) => process.env[key])
	const apply = (values: Readonly<Record<string, string | undefined>>) =>
		Arr.forEach(Rec.toEntries(values), ([key, value]) => {
			if (value === undefined) delete process.env[key]
			else process.env[key] = value
		})
	apply(env)
	await run().finally(() => apply(previous))
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "maple-vite-plugin-"))
	mkdirSync(join(root, "src"))
	writeFileSync(join(root, "src/main.js"), SOURCE)
	received = []
	statuses = []
})
afterEach(() => {
	server?.close()
	server = undefined
	rmSync(root, { recursive: true, force: true })
})

describe("mapleSourceMaps", () => {
	it("uploads each built file's map under its debug id, service and release", async () => {
		const apiUrl = await startApi()
		await runBuild({ service: "web", release: "abc123", apiKey: "maple_ak_test", apiUrl, urlPrefix: "/" })

		const [jsFile] = Arr.filter(readdirSync(join(root, "dist/assets")), Str.endsWith(".js"))
		const code = readFileSync(join(root, "dist/assets", jsFile ?? ""), "utf8")
		const debugId = /\/\/# debugId=([0-9a-f-]{36})/.exec(code)?.[1]
		expect(Arr.filter(readdirSync(join(root, "dist/assets")), Str.endsWith(".map"))).toEqual([])
		expect(received).toHaveLength(1)
		expect(received[0]?.query).toEqual({
			minified_path: `assets/${jsFile}`,
			service: "web",
			debug_id: debugId,
			version: "abc123",
		})
		expect(received[0]?.authorization).toBe("Bearer maple_ak_test")
		expect(JSON.parse(received[0]?.body ?? "{}").sources).toEqual(["../../src/main.js"])
	})

	it("retries a 503 and succeeds", async () => {
		const apiUrl = await startApi()
		statuses = [503]
		await runBuild({ service: "web", apiKey: "maple_ak_test", apiUrl })
		expect(received).toHaveLength(2)
	})

	it("fails the build on a refused upload only with failOnError", async () => {
		const apiUrl = await startApi()
		statuses = [403, 403]
		await runBuild({ service: "web", apiKey: "maple_ak_test", apiUrl })
		await expect(
			runBuild({ service: "web", apiKey: "maple_ak_test", apiUrl, failOnError: true }),
		).rejects.toThrow(/source map upload\(s\) failed/)
	})

	it("keeps the maps on disk without an API key", async () => {
		const apiUrl = await startApi()
		await withEnv({ MAPLE_API_KEY: undefined }, async () => {
			await runBuild({ service: "web", apiUrl })
		})
		expect(received).toEqual([])
		const manifest = JSON.parse(
			readFileSync(join(root, ".maple/sourcemaps/dist/maple-sourcemaps.json"), "utf8"),
		)
		expect(manifest.files).toHaveLength(1)
	})

	it("reads the key and API URL from MAPLE_API_KEY and MAPLE_API_URL", async () => {
		const apiUrl = await startApi()
		await withEnv({ MAPLE_API_KEY: "maple_ak_env", MAPLE_API_URL: apiUrl }, async () => {
			await runBuild({ service: "web" })
		})
		expect(Arr.map(received, (r) => r.authorization)).toEqual(["Bearer maple_ak_env"])
	})

	it("treats an API URL without a scheme as a failed upload, not a crash", async () => {
		await runBuild({ service: "web", apiKey: "maple_ak_test", apiUrl: "api.maple.dev" })
		await expect(
			runBuild({ service: "web", apiKey: "maple_ak_test", apiUrl: "api.maple.dev", failOnError: true }),
		).rejects.toThrow(/not an http\(s\) URL/)
	})

	it("turns maps on for a processed environment that switched them off", async () => {
		const apiUrl = await startApi()
		await runBuild(
			{ service: "web", apiKey: "maple_ak_test", apiUrl },
			{ environments: { client: { build: { sourcemap: false } } } },
		)
		expect(received).toHaveLength(1)
	})

	it("uploads nothing for inline maps, without failing the build", async () => {
		const apiUrl = await startApi()
		await runBuild(
			{ service: "web", apiKey: "maple_ak_test", apiUrl },
			{ build: { sourcemap: "inline" } },
		)
		expect(received).toEqual([])
	})

	it("keeps each output's map when two outputs write the same file name", async () => {
		const apiUrl = await startApi()
		await runBuild(
			{ service: "web", apiKey: "maple_ak_test", apiUrl },
			{
				build: {
					rolldownOptions: {
						output: [
							{ dir: join(root, "dist/plain"), entryFileNames: "app.js", minify: false },
							{ dir: join(root, "dist/minified"), entryFileNames: "app.js", minify: true },
						],
					},
				},
			},
		)
		const manifest = decodeManifest(
			readFileSync(join(root, ".maple/sourcemaps/plain/maple-sourcemaps.json"), "utf8"),
		)
		const ids = Arr.map(manifest.files, (file) => file.debugId)
		expect(new Set(ids).size).toBe(2)
		expect(Arr.map(received, (r) => r.query["debug_id"]).sort()).toEqual([...ids].sort())
		// Each upload carries its own bundle's map, which names that bundle's debug id.
		Arr.forEach(received, (r) => expect(JSON.parse(r.body).debugId).toBe(r.query["debug_id"]))
	})

	it("files maps by release without debug ids when matchBy is release", async () => {
		const apiUrl = await startApi()
		await runBuild({ service: "web", release: "r1", matchBy: "release", apiKey: "maple_ak_test", apiUrl })
		expect(received[0]?.query["debug_id"]).toBeUndefined()
		expect(received[0]?.query["version"]).toBe("r1")
		const body = JSON.parse(received[0]?.body ?? "{}")
		expect([body.debugId, body.debug_id]).toEqual([undefined, undefined])
	})
})
