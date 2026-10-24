import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Effect, Option } from "effect"
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	ABANDONED_STORE_MIN_AGE_MS,
	IN_MEMORY_STORE_PREFIX,
	inMemoryConflicts,
	inMemoryStoreParent,
	isAbandonedStore,
	MIN_TMPFS_FREE_BYTES,
	sweepAbandonedStores,
} from "../src/commands/in-memory-store"

const NO_FLAGS = {
	background: false,
	dataDir: false,
	reset: false,
	minimumRawTelemetryRetentionDays: false,
	checkpointIntervalSet: false,
	onDirtyStoreSet: false,
}

describe("inMemoryStoreParent", () => {
	const free = (bytes: number | undefined) => () =>
		Effect.succeed(bytes === undefined ? Option.none<number>() : Option.some(bytes))

	it("uses tmpfs on Linux when it has room", () => {
		const parent = Effect.runSync(inMemoryStoreParent("linux", free(MIN_TMPFS_FREE_BYTES)))
		expect(parent).toEqual({ dir: "/dev/shm", tmpfs: true })
	})

	it("falls back to the temp dir when tmpfs is Docker-small or missing", () => {
		expect(Effect.runSync(inMemoryStoreParent("linux", free(64 * 1024 * 1024)))).toEqual({
			dir: tmpdir(),
			tmpfs: false,
		})
		expect(Effect.runSync(inMemoryStoreParent("linux", free(undefined))).tmpfs).toBe(false)
	})

	it("never uses tmpfs off Linux", () => {
		expect(Effect.runSync(inMemoryStoreParent("darwin", free(MIN_TMPFS_FREE_BYTES * 8))).tmpfs).toBe(
			false,
		)
	})
})

describe("isAbandonedStore", () => {
	it("keeps a store whose server is alive, however old", () => {
		expect(isAbandonedStore(Option.some(42), ABANDONED_STORE_MIN_AGE_MS * 100, () => true)).toBe(false)
	})

	it("abandons a store whose server is gone", () => {
		expect(isAbandonedStore(Option.some(42), 0, () => false)).toBe(true)
	})

	it("keeps a young store that has not claimed its PID file yet", () => {
		expect(isAbandonedStore(Option.none(), ABANDONED_STORE_MIN_AGE_MS - 1)).toBe(false)
		expect(isAbandonedStore(Option.none(), ABANDONED_STORE_MIN_AGE_MS)).toBe(true)
	})
})

describe("sweepAbandonedStores", () => {
	let parent: string
	beforeEach(() => {
		parent = mkdtempSync(join(tmpdir(), "maple-in-memory-sweep-"))
	})
	afterEach(() => rmSync(parent, { recursive: true, force: true }))

	const store = (name: string, pid: number | undefined, ageMs = 0): string => {
		const root = join(parent, name)
		mkdirSync(join(root, "data"), { recursive: true })
		if (pid !== undefined) writeFileSync(join(root, "maple.pid"), `${pid}\n`)
		const at = (Date.now() - ageMs) / 1000
		utimesSync(root, at, at)
		return root
	}

	it("removes dead runs' stores and keeps live, young and unrelated dirs", async () => {
		const dead = store(`${IN_MEMORY_STORE_PREFIX}dead`, 2_147_483_646)
		const orphan = store(`${IN_MEMORY_STORE_PREFIX}orphan`, undefined, ABANDONED_STORE_MIN_AGE_MS * 2)
		const live = store(`${IN_MEMORY_STORE_PREFIX}live`, process.ppid)
		const young = store(`${IN_MEMORY_STORE_PREFIX}young`, undefined)
		const unrelated = store("someone-else", 2_147_483_646, ABANDONED_STORE_MIN_AGE_MS * 2)

		const removed = await Effect.runPromise(sweepAbandonedStores(parent))

		expect([...removed].sort()).toEqual([dead, orphan].sort())
		expect(existsSync(dead)).toBe(false)
		expect(existsSync(orphan)).toBe(false)
		expect(existsSync(live)).toBe(true)
		expect(existsSync(young)).toBe(true)
		expect(existsSync(unrelated)).toBe(true)
	})

	it("treats a missing parent as nothing to sweep", async () => {
		expect(await Effect.runPromise(sweepAbandonedStores(join(parent, "missing")))).toEqual([])
	})
})

describe("inMemoryConflicts", () => {
	it("allows a plain in-memory start", () => {
		expect(inMemoryConflicts(NO_FLAGS)).toEqual([])
	})

	it("names every flag that needs a persistent store", () => {
		expect(
			inMemoryConflicts({ ...NO_FLAGS, background: true, dataDir: true, checkpointIntervalSet: true }),
		).toEqual(["--background", "--data-dir", "--checkpoint-interval"])
	})
})
