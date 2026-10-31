import { describe, expect, it } from "vitest"
import { Effect, Exit, Scope } from "effect"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startLocal } from "../src/runtime"
import { CURRENT_LOCAL_SCHEMA } from "../src/schema-identity"
import { markStoreOpen, serverPidPath, storeMarkerPath, storeOpenMarkerPath } from "../src/store-version"
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
})
