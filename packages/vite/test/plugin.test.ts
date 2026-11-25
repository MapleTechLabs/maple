import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Array as Arr, Record as Rec, String as Str } from "effect"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { build } from "vite"
import { mapleSourceMaps, type MapleSourceMapsOptions } from "../src/index"

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

const runBuild = (options: MapleSourceMapsOptions) =>
	build({
		root,
		configFile: false,
		logLevel: "silent",
		plugins: [mapleSourceMaps(options)],
		build: { outDir: "dist", rolldownOptions: { input: join(root, "src/main.js") } },
	})

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
		const previous = process.env["MAPLE_API_KEY"]
		delete process.env["MAPLE_API_KEY"]
		await runBuild({ service: "web", apiUrl }).finally(() => {
			if (previous !== undefined) process.env["MAPLE_API_KEY"] = previous
		})
		expect(received).toEqual([])
		const manifest = JSON.parse(
			readFileSync(join(root, ".maple/sourcemaps/dist/maple-sourcemaps.json"), "utf8"),
		)
		expect(manifest.files).toHaveLength(1)
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
