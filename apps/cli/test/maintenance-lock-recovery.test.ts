import { describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { withMaintenanceLock } from "../src/server/checkpoints"

const lockPathOf = (dataDir: string): string => `${resolve(dataDir)}.maple-maintenance-lock`

const withDataDir = async (run: (dataDir: string) => Promise<void>): Promise<void> => {
	const root = mkdtempSync(join(tmpdir(), "maple-lock-recovery-"))
	const dataDir = join(root, "data")
	mkdirSync(dataDir, { recursive: true, mode: 0o700 })
	try {
		await run(dataDir)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
}

const ageLock = (lockPath: string, ms: number): void => {
	const then = new Date(Date.now() - ms)
	utimesSync(lockPath, then, then)
}

const writeOwner = (lockPath: string, owner: Record<string, unknown>): void =>
	writeFileSync(join(lockPath, "owner.json"), JSON.stringify(owner))

describe("maintenance lock recovery", () => {
	it("recovers an old lock whose owner record never got written", async () => {
		await withDataDir(async (dataDir) => {
			const lockPath = lockPathOf(dataDir)
			mkdirSync(lockPath, { mode: 0o700 })
			ageLock(lockPath, 10 * 60_000)
			await expect(withMaintenanceLock(dataDir, randomUUID(), async () => "ran")).resolves.toBe("ran")
			expect(existsSync(lockPath)).toBe(false)
		})
	})

	it("still refuses a fresh lock without an owner record", async () => {
		await withDataDir(async (dataDir) => {
			mkdirSync(lockPathOf(dataDir), { mode: 0o700 })
			await expect(withMaintenanceLock(dataDir, randomUUID(), async () => "ran")).rejects.toThrow(
				/ownership is uncertain/,
			)
		})
	})

	it("refuses an old lock whose owner record cannot be read (EACCES)", async () => {
		await withDataDir(async (dataDir) => {
			const lockPath = lockPathOf(dataDir)
			mkdirSync(lockPath, { mode: 0o700 })
			writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ pid: process.ppid }), { mode: 0o000 })
			ageLock(lockPath, 10 * 60_000)
			await expect(withMaintenanceLock(dataDir, randomUUID(), async () => "ran")).rejects.toThrow(
				/ownership is uncertain/,
			)
			expect(existsSync(join(lockPath, "owner.json"))).toBe(true)
		})
	})

	it("refuses an old lock whose owner record is malformed", async () => {
		await withDataDir(async (dataDir) => {
			const lockPath = lockPathOf(dataDir)
			mkdirSync(lockPath, { mode: 0o700 })
			writeFileSync(join(lockPath, "owner.json"), "{not json")
			ageLock(lockPath, 10 * 60_000)
			await expect(withMaintenanceLock(dataDir, randomUUID(), async () => "ran")).rejects.toThrow(
				/ownership is uncertain/,
			)
		})
	})

	// Another instance under our PID: a re-created container, or a sibling
	// container sharing the store (both PID 1).
	const writeOtherInstanceOwner = (lockPath: string): void =>
		writeOwner(lockPath, {
			formatVersion: 1,
			operationId: randomUUID(),
			pid: process.pid,
			startedAt: new Date().toISOString(),
			instanceId: randomUUID(),
		})

	it("recovers a lock left under this PID by another instance once its heartbeat is stale", async () => {
		await withDataDir(async (dataDir) => {
			const lockPath = lockPathOf(dataDir)
			mkdirSync(lockPath, { mode: 0o700 })
			writeOtherInstanceOwner(lockPath)
			ageLock(lockPath, 10 * 60_000)
			await expect(withMaintenanceLock(dataDir, randomUUID(), async () => "ran")).resolves.toBe("ran")
		})
	})

	it("refuses a lock held under this PID by another instance with a fresh heartbeat", async () => {
		await withDataDir(async (dataDir) => {
			const lockPath = lockPathOf(dataDir)
			mkdirSync(lockPath, { mode: 0o700 })
			writeOtherInstanceOwner(lockPath)
			await expect(withMaintenanceLock(dataDir, randomUUID(), async () => "ran")).rejects.toThrow(
				/another Maple maintenance operation is active/,
			)
		})
	})

	it("refuses an old lock under this PID from a build without heartbeats", async () => {
		await withDataDir(async (dataDir) => {
			const lockPath = lockPathOf(dataDir)
			mkdirSync(lockPath, { mode: 0o700 })
			writeOwner(lockPath, {
				formatVersion: 1,
				operationId: randomUUID(),
				pid: process.pid,
				startedAt: new Date().toISOString(),
			})
			ageLock(lockPath, 10 * 60_000)
			const attempt = withMaintenanceLock(dataDir, randomUUID(), async () => "ran")
			await expect(attempt).rejects.toThrow(/another Maple maintenance operation is active/)
			await expect(attempt).rejects.toThrow(`remove ${lockPath}`)
		})
	})

	it("keeps a long-running hold fresh with its heartbeat", async () => {
		await withDataDir(async (dataDir) => {
			const lockPath = lockPathOf(dataDir)
			const ageWhileHeld = await withMaintenanceLock(
				dataDir,
				randomUUID(),
				async () => {
					ageLock(lockPath, 10 * 60_000)
					// Block the main thread: the heartbeat must not depend on it.
					const until = Date.now() + 200
					while (Date.now() < until) {}
					return Date.now() - statSync(lockPath).mtimeMs
				},
				{ heartbeatMs: 20 },
			)
			expect(ageWhileHeld).toBeLessThan(5_000)
			expect(existsSync(lockPath)).toBe(false)
		})
	})

	it("refuses an old lock whose record names a live foreign process", async () => {
		await withDataDir(async (dataDir) => {
			const lockPath = lockPathOf(dataDir)
			mkdirSync(lockPath, { mode: 0o700 })
			writeOwner(lockPath, { formatVersion: 99, pid: process.ppid })
			ageLock(lockPath, 10 * 60_000)
			await expect(withMaintenanceLock(dataDir, randomUUID(), async () => "ran")).rejects.toThrow(
				/another Maple maintenance operation is active/,
			)
		})
	})
})
