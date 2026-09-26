import { describe, it } from "@effect/vitest"
import { deepStrictEqual, ok, strictEqual } from "node:assert"
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	adoptLegacySidecars,
	dataDirSidecarPath,
	isStoreDirty,
	legacySidecarPath,
	makeStoreMarker,
	markStoreClosed,
	markStoreClosedDurable,
	markStoreOpen,
	markStoreOpenDurable,
	newerStoreSchemaVersion,
	readMarker,
	schemaFingerprint,
	serverPidPath,
	storeMarkerPath,
	storeOpenMarkerPath,
} from "../src/server/store-version"

// Each test gets a throwaway parent dir; the data dir is a child of it so the
// markers (written beside the data dir) land in the temp tree, not on $HOME.
const withDataDir = (run: (dataDir: string) => void): void => {
	const parent = mkdtempSync(join(tmpdir(), "maple-store-test-"))
	const dataDir = join(parent, "data")
	mkdirSync(dataDir, { recursive: true })
	try {
		run(dataDir)
	} finally {
		rmSync(parent, { recursive: true, force: true })
	}
}

/** Simulate a bootstrapped store (chDB creates `store/`). */
const seedData = (dataDir: string): void => mkdirSync(join(dataDir, "store"), { recursive: true })

/** Write a legacy (pre-v2) store marker beside the data dir. */
const writeMarker = (dataDir: string, schema: string): void =>
	writeFileSync(
		storeMarkerPath(dataDir),
		JSON.stringify({ chdb: "dev", maple: "dev", createdAt: "2026-01-01T00:00:00.000Z", schema }),
	)

/** A throwaway parent holding any number of data dirs, by basename. */
const withParent = (run: (parent: string) => void): void => {
	const parent = mkdtempSync(join(tmpdir(), "maple-sidecar-test-"))
	try {
		run(parent)
	} finally {
		rmSync(parent, { recursive: true, force: true })
	}
}

describe("clean-shutdown sentinel", () => {
	it("storeOpenMarkerPath sits beside the data dir", () => {
		withDataDir((dataDir) => {
			strictEqual(storeOpenMarkerPath(dataDir), join(dataDir, "..", "maple-store-open"))
		})
	})

	it("markStoreOpen writes the marker; markStoreClosed removes it", () => {
		withDataDir((dataDir) => {
			markStoreOpen(dataDir)
			ok(existsSync(storeOpenMarkerPath(dataDir)))
			markStoreClosed(dataDir)
			ok(!existsSync(storeOpenMarkerPath(dataDir)))
		})
	})

	it("markStoreClosed is a no-op when the marker is already gone", () => {
		withDataDir((dataDir) => {
			markStoreClosed(dataDir) // must not throw
			ok(!existsSync(storeOpenMarkerPath(dataDir)))
		})
	})

	it("durable migration sentinels survive the connection lifecycle", async () => {
		const parent = mkdtempSync(join(tmpdir(), "maple-store-migration-sentinel-"))
		const dataDir = join(parent, "data")
		mkdirSync(dataDir, { recursive: true })
		try {
			seedData(dataDir)
			await markStoreOpenDurable(dataDir)
			strictEqual(isStoreDirty(dataDir), true)
			await markStoreClosedDurable(dataDir)
			strictEqual(isStoreDirty(dataDir), false)
		} finally {
			rmSync(parent, { recursive: true, force: true })
		}
	})

	it("process kill leaves a populated migration source dirty", async () => {
		const parent = mkdtempSync(join(tmpdir(), "maple-store-migration-kill-"))
		const dataDir = join(parent, "data")
		mkdirSync(dataDir, { recursive: true })
		seedData(dataDir)
		let child: ChildProcess | undefined
		try {
			const moduleUrl = new URL("../src/server/store-version.ts", import.meta.url).href
			child = spawn(
				process.execPath,
				[
					"-e",
					`(async () => { const { markStoreOpenDurable } = await import(process.env.MAPLE_MIGRATION_TEST_MODULE_URL); await markStoreOpenDurable(process.env.MAPLE_MIGRATION_TEST_DATA_DIR); process.stdout.write("ready\\n"); await new Promise(() => {}); })()`,
				],
				{
					env: {
						...process.env,
						MAPLE_MIGRATION_TEST_DATA_DIR: dataDir,
						MAPLE_MIGRATION_TEST_MODULE_URL: moduleUrl,
					},
					stdio: ["ignore", "pipe", "pipe"],
				},
			)
			await new Promise<void>((resolve, reject) => {
				let stdout = ""
				const timeout = setTimeout(
					() => reject(new Error("sentinel child did not become ready")),
					5000,
				)
				child!.stdout?.on("data", (chunk: Buffer) => {
					stdout += chunk.toString()
					if (stdout.includes("ready\n")) {
						clearTimeout(timeout)
						resolve()
					}
				})
				child!.once("error", (error) => {
					clearTimeout(timeout)
					reject(error)
				})
				child!.once("exit", (code, signal) => {
					clearTimeout(timeout)
					if (!stdout.includes("ready\n"))
						reject(new Error(`sentinel child exited before becoming ready (${code ?? signal})`))
				})
			})
			const exited = new Promise<void>((resolve) => child!.once("exit", () => resolve()))
			child.kill("SIGKILL")
			await exited
			strictEqual(isStoreDirty(dataDir), true)
		} finally {
			if (child && child.exitCode === null) child.kill("SIGKILL")
			rmSync(parent, { recursive: true, force: true })
		}
	})

	it("isStoreDirty: false for a clean store (data, no marker)", () => {
		withDataDir((dataDir) => {
			seedData(dataDir)
			strictEqual(isStoreDirty(dataDir), false)
		})
	})

	it("isStoreDirty: false for a marker over an empty store (fresh open, never persisted)", () => {
		withDataDir((dataDir) => {
			markStoreOpen(dataDir)
			strictEqual(isStoreDirty(dataDir), false)
		})
	})

	it("isStoreDirty: true only when the store has data AND was not cleanly closed", () => {
		withDataDir((dataDir) => {
			seedData(dataDir)
			markStoreOpen(dataDir)
			strictEqual(isStoreDirty(dataDir), true)
			// A clean close clears the dirty state.
			markStoreClosed(dataDir)
			strictEqual(isStoreDirty(dataDir), false)
		})
	})
})

describe("schemaFingerprint", () => {
	it("is stable across cosmetic edits (comments, whitespace, indentation)", () => {
		const a = "CREATE TABLE t (\n  Id String, -- the id\n  Name String\n);"
		const b = "  CREATE TABLE t (    Id String,   Name String   ); -- reworded\n\n"
		strictEqual(schemaFingerprint(a), schemaFingerprint(b))
	})

	it("changes when a column is added (structural change)", () => {
		const before = "CREATE TABLE t (Id String);"
		const after = "CREATE TABLE t (Id String, ServiceNamespace String);"
		ok(schemaFingerprint(before) !== schemaFingerprint(after))
	})
})

describe("store marker schema stamp", () => {
	it("round-trips the schema fingerprint through readMarker", () => {
		withDataDir((dataDir) => {
			seedData(dataDir)
			writeMarker(dataDir, "abc123")
			strictEqual(readMarker(dataDir)?.schema, "abc123")
		})
	})

	it("reads an empty schema for a legacy marker without the field", () => {
		withDataDir((dataDir) => {
			seedData(dataDir)
			writeFileSync(storeMarkerPath(dataDir), JSON.stringify({ chdb: "dev", maple: "dev" }))
			strictEqual(readMarker(dataDir)?.schema, "")
		})
	})
})

describe("per-data-dir sidecar paths", () => {
	it("keeps the default `data` layout byte-for-byte", () => {
		strictEqual(dataDirSidecarPath("/home/u/.maple/data", "maple.pid"), "/home/u/.maple/maple.pid")
		strictEqual(storeMarkerPath("/home/u/.maple/data"), "/home/u/.maple/maple-store-version.json")
		strictEqual(storeOpenMarkerPath("/home/u/.maple/data"), "/home/u/.maple/maple-store-open")
		strictEqual(serverPidPath("/home/u/.maple/data/"), "/home/u/.maple/maple.pid")
	})

	it("prefixes any other basename so siblings never share state", () => {
		strictEqual(storeOpenMarkerPath("/home/u/.maple/data-b"), "/home/u/.maple/data-b.maple-store-open")
		strictEqual(serverPidPath("/var/lib/maple"), "/var/lib/maple.maple.pid")
	})

	it("a crash of one store no longer makes its sibling look dirty", () => {
		withParent((parent) => {
			const a = join(parent, "data")
			const b = join(parent, "data-b")
			seedData(a)
			seedData(b)
			markStoreOpen(a)
			strictEqual(isStoreDirty(a), true)
			strictEqual(isStoreDirty(b), false)
			markStoreOpen(b)
			markStoreClosed(b)
			strictEqual(isStoreDirty(a), true)
		})
	})
})

describe("legacy sidecar adoption", () => {
	it("moves a custom store's pre-namespacing marker and dirty sentinel beside it", () => {
		withParent((parent) => {
			const dataDir = join(parent, "maple")
			seedData(dataDir)
			writeFileSync(
				legacySidecarPath(dataDir, "maple-store-version.json"),
				'{"chdb":"dev","schema":"fp"}',
			)
			writeFileSync(legacySidecarPath(dataDir, "maple-store-open"), "999999\n")
			// Adopted on first read: the store reads as versioned and dirty, as it was.
			strictEqual(isStoreDirty(dataDir), true)
			strictEqual(readMarker(dataDir)?.schema, "fp")
			ok(existsSync(join(parent, "maple.maple-store-version.json")))
			ok(!existsSync(join(parent, "maple-store-version.json")))
			deepStrictEqual(adoptLegacySidecars(dataDir), [])
		})
	})

	it("never adopts files a `data` sibling owns", () => {
		withParent((parent) => {
			seedData(join(parent, "data"))
			const other = join(parent, "data-b")
			seedData(other)
			writeFileSync(legacySidecarPath(other, "maple-store-open"), "999999\n")
			deepStrictEqual(adoptLegacySidecars(other), [])
			strictEqual(isStoreDirty(other), false)
			strictEqual(isStoreDirty(join(parent, "data")), true)
		})
	})

	it("leaves an empty store and an already-migrated store alone", () => {
		withParent((parent) => {
			const dataDir = join(parent, "maple")
			mkdirSync(dataDir, { recursive: true })
			writeFileSync(legacySidecarPath(dataDir, "maple-store-open"), "999999\n")
			deepStrictEqual(adoptLegacySidecars(dataDir), [])
			seedData(dataDir)
			writeFileSync(storeMarkerPath(dataDir), "{}")
			deepStrictEqual(adoptLegacySidecars(dataDir), [])
			ok(existsSync(legacySidecarPath(dataDir, "maple-store-open")))
		})
	})

	it("waits while an older server still runs from the legacy PID file", () => {
		withParent((parent) => {
			const dataDir = join(parent, "maple")
			seedData(dataDir)
			writeFileSync(legacySidecarPath(dataDir, "maple.pid"), String(process.ppid))
			writeFileSync(legacySidecarPath(dataDir, "maple-store-open"), `${process.ppid}\n`)
			deepStrictEqual(adoptLegacySidecars(dataDir), [])
		})
	})
})

describe("newerStoreSchemaVersion", () => {
	const markerAt = (version: number) =>
		makeStoreMarker("0.9.0", "2026-01-01T00:00:00.000Z", "0123456789abcdef", {
			schemaVersion: version,
			schemaDigest: "a".repeat(64),
		})

	it("reports a store written by a newer maple, and nothing else", () => {
		withDataDir((dataDir) => {
			seedData(dataDir)
			writeFileSync(storeMarkerPath(dataDir), JSON.stringify(markerAt(9)))
			strictEqual(newerStoreSchemaVersion(dataDir, 8), 9)
			strictEqual(newerStoreSchemaVersion(dataDir, 9), undefined)
			strictEqual(newerStoreSchemaVersion(dataDir, 10), undefined)
		})
	})

	it("ignores legacy markers and empty stores", () => {
		withDataDir((dataDir) => {
			writeFileSync(storeMarkerPath(dataDir), JSON.stringify(markerAt(9)))
			strictEqual(newerStoreSchemaVersion(dataDir, 1), undefined)
			seedData(dataDir)
			writeMarker(dataDir, "fp")
			strictEqual(newerStoreSchemaVersion(dataDir, 1), undefined)
		})
	})
})
