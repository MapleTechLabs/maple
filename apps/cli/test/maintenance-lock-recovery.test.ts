import { describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
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

	it("recovers a lock left under this PID by an earlier process instance", async () => {
		await withDataDir(async (dataDir) => {
			const lockPath = lockPathOf(dataDir)
			mkdirSync(lockPath, { mode: 0o700 })
			writeOwner(lockPath, {
				formatVersion: 1,
				operationId: randomUUID(),
				pid: process.pid,
				startedAt: new Date().toISOString(),
			})
			await expect(withMaintenanceLock(dataDir, randomUUID(), async () => "ran")).resolves.toBe("ran")
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
