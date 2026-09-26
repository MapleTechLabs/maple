import { describe, it } from "@effect/vitest"
import * as BunServices from "@effect/platform-bun/BunServices"
import { strict as assert } from "node:assert"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Option } from "effect"
import { FileSystem } from "effect/FileSystem"
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/unstable/http"
import { discoverLocalUrl, discoverServers, probeLocal } from "./mode"

type Route = { readonly status: number; readonly body: string } | "refuse" | "hang"

/** An HttpClient answering from a route table instead of the network. */
const fakeClient = (routes: Readonly<Record<string, Route>>) =>
	HttpClient.make((request, url) => {
		const route = routes[url.pathname] ?? { status: 404, body: "not found" }
		if (route === "hang") return Effect.never
		if (route === "refuse") {
			return Effect.fail(
				new HttpClientError.HttpClientError({
					reason: new HttpClientError.TransportError({
						request,
						description: "connection refused",
					}),
				}),
			)
		}
		return Effect.succeed(
			HttpClientResponse.fromWeb(request, new Response(route.body, { status: route.status })),
		)
	})

// Plain promises: `it.effect` hangs under `bun test`.
const probe = (routes: Readonly<Record<string, Route>>) =>
	Effect.runPromise(probeLocal(fakeClient(routes), "http://127.0.0.1:4318", Duration.millis(50)))

describe("local server probe", () => {
	it("accepts a server that identifies as maple-local", async () => {
		assert.equal(
			await probe({ "/local/status": { status: 200, body: '{"service":"maple-local","pid":1}' } }),
			"maple",
		)
	})

	it("falls back to /health for binaries that predate /local/status", async () => {
		assert.equal(await probe({ "/health": { status: 200, body: "OK" } }), "maple")
	})

	// An unrelated dev server answering 2xx used to be taken for Maple.
	it("rejects an unrelated app that answers 2xx", async () => {
		assert.equal(await probe({ "/local/status": { status: 200, body: "<html></html>" } }), "foreign")
		assert.equal(await probe({ "/health": { status: 200, body: '{"status":"healthy"}' } }), "foreign")
	})

	it("tells a busy server from an absent one", async () => {
		assert.equal(await probe({ "/local/status": "hang" }), "busy")
		assert.equal(await probe({ "/local/status": "refuse" }), "absent")
	})
})

describe("server discovery file", () => {
	const withFile = async (content: string): Promise<Option.Option<string>> => {
		const dir = mkdtempSync(join(tmpdir(), "maple-discovery-"))
		try {
			const file = join(dir, "maple-server.json")
			writeFileSync(file, content)
			return await Effect.runPromise(
				Effect.flatMap(FileSystem, (fs) => discoverLocalUrl(fs, file)).pipe(
					Effect.provide(BunServices.layer),
				),
			)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	}

	it("uses the advertised URL while the server's pid is alive", async () => {
		const url = await withFile(
			JSON.stringify({
				pid: process.pid,
				url: "http://127.0.0.1:4393",
				dataDir: "/x",
				startedAt: "now",
			}),
		)
		assert.deepStrictEqual(url, Option.some("http://127.0.0.1:4393"))
	})

	it("ignores a stale file and a malformed one", async () => {
		// Far above any real pid limit, so it is never alive.
		assert.deepStrictEqual(
			await withFile(JSON.stringify({ pid: 2 ** 30, url: "http://x" })),
			Option.none(),
		)
		assert.deepStrictEqual(await withFile("{not json"), Option.none())
	})
})

describe("server discovery scan", () => {
	const scan = async (files: Readonly<Record<string, unknown>>) => {
		const dir = mkdtempSync(join(tmpdir(), "maple-scan-"))
		try {
			for (const [name, body] of Object.entries(files))
				writeFileSync(join(dir, name), JSON.stringify(body))
			return await Effect.runPromise(
				Effect.flatMap(FileSystem, (fs) => discoverServers(fs, dir)).pipe(
					Effect.provide(BunServices.layer),
				),
			)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	}
	const alive = (url: string) => ({ pid: process.pid, url })
	const dead = (url: string) => ({ pid: 2 ** 30, url })

	it("prefers the default store, then the only other live one", async () => {
		const both = await scan({
			"maple-server.json": alive("http://a"),
			"dev.maple-server.json": alive("http://b"),
		})
		assert.deepStrictEqual(both.url, Option.some("http://a"))
		const other = await scan({
			"maple-server.json": dead("http://a"),
			"dev.maple-server.json": alive("http://b"),
		})
		assert.deepStrictEqual(other.url, Option.some("http://b"))
	})

	it("reports several live servers instead of guessing", async () => {
		const found = await scan({
			"a.maple-server.json": alive("http://a"),
			"b.maple-server.json": alive("http://b"),
		})
		assert.deepStrictEqual(found.url, Option.none())
		assert.deepStrictEqual(found.ambiguous, ["http://a", "http://b"])
	})
})
