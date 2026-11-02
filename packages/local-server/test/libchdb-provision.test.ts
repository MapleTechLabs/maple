import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import { FetchHttpClient } from "effect/http"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { platformLibchdbAsset, provisionLibchdb, type ProvisionOptions } from "../src/libchdb-provision"

const provision = (options: ProvisionOptions) =>
	provisionLibchdb(options).pipe(Effect.provide(FetchHttpClient.layer))

const asset = platformLibchdbAsset()
if (asset === undefined) throw new Error(`no libchdb asset for ${process.platform}-${process.arch}`)

/** A release archive shaped like chdb-core's: the library nested in a directory. */
const releaseArchive = (root: string, library: string): Uint8Array => {
	const tree = join(root, "tree")
	mkdirSync(join(tree, "lib"), { recursive: true })
	writeFileSync(join(tree, "lib", "libchdb.so"), library)
	const archive = join(root, asset)
	const tar = Bun.spawnSync(["tar", "-czf", archive, "-C", tree, "lib"])
	if (tar.exitCode !== 0) throw new Error("tar failed")
	return new Uint8Array(readFileSync(archive))
}

const withReleaseServer = async (
	run: (ctx: {
		baseUrl: string
		cacheRoot: string
		archive: Uint8Array
		requests: string[]
	}) => Promise<void>,
	respond?: (path: string) => Response | undefined,
) => {
	const root = mkdtempSync(join(tmpdir(), "maple-libchdb-provision-"))
	const archive = releaseArchive(root, "fake libchdb bytes")
	const requests: string[] = []
	const server = Bun.serve({
		port: 0,
		fetch: (request) => {
			const path = new URL(request.url).pathname
			requests.push(path)
			return (
				respond?.(path) ??
				(path === `/v1.0.0/${asset}` ? new Response(archive) : new Response(null, { status: 404 }))
			)
		},
	})
	try {
		await run({
			baseUrl: `http://127.0.0.1:${server.port}`,
			cacheRoot: join(root, "cache"),
			archive,
			requests,
		})
	} finally {
		server.stop(true)
		rmSync(root, { recursive: true, force: true })
	}
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

describe("provisionLibchdb", () => {
	it("installs a verified release once and reuses the cached copy", async () => {
		await withReleaseServer(async ({ baseUrl, cacheRoot, archive, requests }) => {
			const release = { version: "v1.0.0", sha256: { [asset]: sha256(archive) } }
			const first = await Effect.runPromise(provision({ cacheRoot, baseUrl, release }))
			expect(first.downloaded).toBe(true)
			expect(readFileSync(first.path, "utf8")).toBe("fake libchdb bytes")

			const second = await Effect.runPromise(provision({ cacheRoot, baseUrl, release }))
			expect(second).toEqual({ ...first, downloaded: false })
			expect(requests).toEqual([`/v1.0.0/${asset}`])
			// No staging directories survive a successful install.
			expect(readdirSync(cacheRoot)).toEqual(["v1.0.0"])
		})
	})

	it("downloads again when the cached library no longer matches its install digest", async () => {
		await withReleaseServer(async ({ baseUrl, cacheRoot, archive, requests }) => {
			const release = { version: "v1.0.0", sha256: { [asset]: sha256(archive) } }
			const first = await Effect.runPromise(provision({ cacheRoot, baseUrl, release }))
			writeFileSync(first.path, "tampered")

			const second = await Effect.runPromise(provision({ cacheRoot, baseUrl, release }))
			expect(second.downloaded).toBe(true)
			expect(readFileSync(second.path, "utf8")).toBe("fake libchdb bytes")
			expect(requests).toEqual([`/v1.0.0/${asset}`, `/v1.0.0/${asset}`])
		})
	})

	it("refuses an archive whose checksum does not match the pin and installs nothing", async () => {
		await withReleaseServer(async ({ baseUrl, cacheRoot }) => {
			const release = { version: "v1.0.0", sha256: { [asset]: "0".repeat(64) } }
			const exit = await Effect.runPromiseExit(provision({ cacheRoot, baseUrl, release }))
			expect(Exit.isFailure(exit)).toBe(true)
			expect(JSON.stringify(exit)).toContain("checksum mismatch")
			expect(existsSync(join(cacheRoot, "v1.0.0"))).toBe(false)
		})
	})

	it("fails on a missing release without retrying", async () => {
		await withReleaseServer(async ({ baseUrl, cacheRoot, requests }) => {
			const release = { version: "v2.0.0", sha256: { [asset]: "0".repeat(64) } }
			const exit = await Effect.runPromiseExit(provision({ cacheRoot, baseUrl, release }))
			expect(JSON.stringify(exit)).toContain("HTTP 404")
			expect(requests).toEqual([`/v2.0.0/${asset}`])
		})
	})
})
