import { describe, expect, it } from "vitest"
import { ConfigProvider, Effect, Exit, Logger, Scope } from "effect"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startLocal } from "../src/runtime"
import { CURRENT_LOCAL_SCHEMA } from "../src/schema-identity"
import {
	markStoreOpen,
	serverDiscoveryPath,
	serverPidPath,
	storeMarkerPath,
	storeOpenMarkerPath,
} from "../src/store-version"
import { CHDB_VERSION } from "../src/version"

const withStore = async (run: (dataDir: string) => Promise<void>) => {
	const root = mkdtempSync(join(tmpdir(), "maple-local-runtime-"))
	const dataDir = join(root, "data")
	mkdirSync(join(dataDir, "metadata"), { recursive: true })
	writeFileSync(
		storeMarkerPath(dataDir),
		JSON.stringify({
			formatVersion: 2,
			storeId: "8b7d9f1e-0000-4000-8000-000000000001",
			chdb: CHDB_VERSION,
			maple: "dev",
			createdAt: "2026-01-01T00:00:00.000Z",
			schemaVersion: CURRENT_LOCAL_SCHEMA.version,
			schemaDigest: CURRENT_LOCAL_SCHEMA.digest,
			schema: CURRENT_LOCAL_SCHEMA.fingerprint,
			activation: "active",
		}),
	)
	try {
		await run(dataDir)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
}

// These refusal paths deliberately require no native library. Native opening,
// ingest and finalization are covered by the host's end-to-end smoke scenario.
describe("scoped local runtime safety", () => {
	it("refuses dirty stores before opening chDB and releases its claim", async () => {
		await withStore(async (dataDir) => {
			markStoreOpen(dataDir)
			const error = await Effect.runPromise(
				Effect.scoped(startLocal({ dataDir, port: 0 })).pipe(Effect.flip),
			)
			expect(error._tag).toBe("@maple/cli/LocalStoreDirtyError")
			expect(existsSync(storeOpenMarkerPath(dataDir))).toBe(true)
			expect(existsSync(serverPidPath(dataDir))).toBe(false)
		})
	})

	it("releases a failed start even when the host keeps its scope open, so a retry can proceed", async () => {
		await withStore(async (dataDir) => {
			markStoreOpen(dataDir)
			// Alchemy retries a failed local resource in the same process without
			// closing the scope the failed attempt ran in.
			const held = await Effect.runPromise(Scope.make())
			const attempt = startLocal({ dataDir, port: 0 }).pipe(Scope.provide(held), Effect.flip)
			const first = await Effect.runPromise(attempt)
			expect(existsSync(serverPidPath(dataDir))).toBe(false)
			const retry = await Effect.runPromise(attempt)
			expect([first._tag, retry._tag]).toEqual([
				"@maple/cli/LocalStoreDirtyError",
				"@maple/cli/LocalStoreDirtyError",
			])
			await Effect.runPromise(Scope.close(held, Exit.void))
		})
	})

	it("wipes a dirty store's live data only when asked to", async () => {
		await withStore(async (dataDir) => {
			const liveData = join(dataDir, "metadata", "default.sql")
			writeFileSync(liveData, "ATTACH DATABASE default")
			markStoreOpen(dataDir)
			// A library path that cannot load stops startup right after the store
			// decision, so the test needs no native chDB.
			const exit = await Effect.runPromiseExit(
				Effect.scoped(
					startLocal({
						dataDir,
						port: 0,
						onDirtyStore: "wipe",
						libchdb: join(dataDir, "missing.so"),
					}),
				),
			)
			expect(JSON.stringify(exit)).not.toContain("LocalStoreDirtyError")
			expect(existsSync(liveData)).toBe(false)
			expect(existsSync(serverPidPath(dataDir))).toBe(false)
		})
	})

	it("refuses an invalid MAPLE_LOCAL_UI_URL before opening the store", async () => {
		await withStore(async (dataDir) => {
			const env = ConfigProvider.layer(
				ConfigProvider.fromEnvRecord({ MAPLE_LOCAL_UI_URL: "not a url" }),
			)
			const error = await Effect.runPromise(
				Effect.scoped(startLocal({ dataDir, port: 0 })).pipe(Effect.flip, Effect.provide(env)),
			)
			expect(error._tag).toBe("@maple/local-server/LocalUiUrlError")
			expect(existsSync(serverPidPath(dataDir))).toBe(false)
		})
	})

	it("refuses an incompatible populated store without loading its native metadata", async () => {
		await withStore(async (dataDir) => {
			writeFileSync(
				storeMarkerPath(dataDir),
				JSON.stringify({
					chdb: "incompatible-test-build",
					maple: "test",
					createdAt: "2026-01-01",
					schema: CURRENT_LOCAL_SCHEMA.fingerprint,
				}),
			)
			const error = await Effect.runPromise(
				Effect.scoped(startLocal({ dataDir, port: 0 })).pipe(Effect.flip),
			)
			expect(error._tag).toBe("@maple/cli/LocalStoreIncompatibleError")
			expect(existsSync(serverPidPath(dataDir))).toBe(false)
		})
	})

	it("binds exactly an explicit port and fails when it is taken", async () => {
		await withStore(async (dataDir) => {
			const holder = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
			try {
				const error = await Effect.runPromise(
					Effect.scoped(startLocal({ dataDir, port: holder.port })).pipe(Effect.flip),
				)
				expect(error._tag).toBe("@maple/cli/ServerBindError")
				expect(error.message).toContain("the `port` option")
				expect(existsSync(serverPidPath(dataDir))).toBe(false)
			} finally {
				holder.stop(true)
			}
		})
	})
})

/** A live process that owns `dataDir` the way another `alchemy dev` sidecar would. */
const withForeignOwner = async (dataDir: string, run: (owner: Bun.Subprocess) => Promise<void>) => {
	const owner = Bun.spawn(["sleep", "30"])
	// The claim must postdate the process, or it reads as a reused PID.
	await Bun.sleep(1100)
	writeFileSync(serverPidPath(dataDir), String(owner.pid))
	writeFileSync(
		serverDiscoveryPath(dataDir),
		JSON.stringify({
			pid: owner.pid,
			url: "http://127.0.0.1:47123",
			dataDir,
			startedAt: new Date().toISOString(),
		}),
	)
	try {
		await run(owner)
	} finally {
		owner.kill()
	}
}

describe("a store another process already serves", () => {
	it("shares the owner's server instead of opening the store", async () => {
		await withStore(async (dataDir) => {
			await withForeignOwner(dataDir, async (owner) => {
				const server = await Effect.runPromise(Effect.scoped(startLocal({ dataDir })))
				expect(server.endpoint).toBe("http://127.0.0.1:47123")
				expect(server.dashboardUrl).toContain("port=47123")
				expect(server.sharedWith).toBe(owner.pid)
				// The owner's claim is untouched.
				expect(readFileSync(serverPidPath(dataDir), "utf8")).toBe(String(owner.pid))
			})
		})
	})

	it("refuses to share a server on another port than the explicit one", async () => {
		await withStore(async (dataDir) => {
			await withForeignOwner(dataDir, async (owner) => {
				const exit = await Effect.runPromiseExit(Effect.scoped(startLocal({ dataDir, port: 47124 })))
				expect(Exit.isFailure(exit) && String(exit.cause)).toContain(
					`already served by PID ${owner.pid} on port 47123, not port 47124`,
				)
				const shared = await Effect.runPromise(Effect.scoped(startLocal({ dataDir, port: 47123 })))
				expect(shared.sharedWith).toBe(owner.pid)
			})
		})
	})

	it("takes over only on the owner's port, which the Workers export to", async () => {
		await withStore(async (dataDir) => {
			markStoreOpen(dataDir)
			const logs: string[] = []
			const capture = Logger.layer([
				Logger.make(({ message }) => {
					logs.push(String(Array.isArray(message) ? message.join(" ") : message))
				}),
			])
			await withForeignOwner(dataDir, async (owner) => {
				const scope = await Effect.runPromise(Scope.make())
				await Effect.runPromise(
					startLocal({ dataDir }).pipe(Scope.provide(scope), Effect.provide(capture)),
				)
				// Something else binds the owner's port as it exits.
				const squatter = Bun.listen({ hostname: "127.0.0.1", port: 47123, socket: { data() {} } })
				owner.kill()
				await owner.exited
				for (let i = 0; i < 50 && !logs.some((line) => line.includes("cannot take over")); i++)
					await Bun.sleep(100)
				squatter.stop(true)
				await Effect.runPromise(Scope.close(scope, Exit.void))
			})
			expect(logs.find((line) => line.includes("cannot take over"))).toContain(
				"port 47123 on 127.0.0.1 is already in use",
			)
		})
	})

	it("takes the store over once the owner exits, and keeps trying when that fails", async () => {
		await withStore(async (dataDir) => {
			// Dirty, so the takeover stops at the store check without loading chDB.
			markStoreOpen(dataDir)
			const logs: string[] = []
			const capture = Logger.layer([
				Logger.make(({ message }) => {
					logs.push(String(Array.isArray(message) ? message.join(" ") : message))
				}),
			])
			await withForeignOwner(dataDir, async (owner) => {
				const scope = await Effect.runPromise(Scope.make())
				await Effect.runPromise(
					startLocal({ dataDir }).pipe(Scope.provide(scope), Effect.provide(capture)),
				)
				owner.kill()
				await owner.exited
				const failures = () => logs.filter((line) => line.includes("cannot take over"))
				for (let i = 0; i < 80 && failures().length < 2; i++) await Bun.sleep(100)
				await Effect.runPromise(Scope.close(scope, Exit.void))
			})
			const failures = logs.filter((line) => line.includes("cannot take over"))
			expect(failures.length).toBeGreaterThanOrEqual(2)
			expect(failures[0]).toContain("not cleanly closed")
			expect(logs.filter((line) => line.includes("taking it over")).length).toBeGreaterThanOrEqual(2)
			expect(existsSync(serverPidPath(dataDir))).toBe(false)
		})
	}, 15_000)
})
