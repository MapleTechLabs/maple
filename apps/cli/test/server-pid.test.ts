import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { claimPidFileExclusive } from "../src/commands/server"

const withPidPath = async (run: (pidPath: string, root: string) => Promise<void>): Promise<void> => {
	const root = mkdtempSync(join(tmpdir(), "maple-pid-claim-"))
	try {
		await run(join(root, "maple.pid"), root)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
}

/** A PID that certainly belonged to a process which has since exited. */
const deadPid = (): number => Bun.spawnSync(["true"]).pid

describe("start PID claim is exclusive", () => {
	it("writes exactly the bare PID, readable by older builds", async () => {
		await withPidPath(async (pidPath) => {
			await Effect.runPromise(claimPidFileExclusive(pidPath))
			expect(readFileSync(pidPath, "utf8")).toBe(String(process.pid))
		})
	})

	it("refuses while a live process that wrote the file still holds it", async () => {
		await withPidPath(async (pidPath) => {
			// The runner's parent started before this write, so it provably owns it.
			writeFileSync(pidPath, String(process.ppid))
			const second = await Effect.runPromiseExit(claimPidFileExclusive(pidPath))
			expect(Exit.isFailure(second)).toBe(true)
			expect(JSON.stringify(second)).toContain("already running or starting")
			expect(readFileSync(pidPath, "utf8")).toBe(String(process.ppid))
		})
	})

	it("takes over a PID file whose process is gone, leaving no debris", async () => {
		await withPidPath(async (pidPath, root) => {
			writeFileSync(pidPath, String(deadPid()))
			await Effect.runPromise(claimPidFileExclusive(pidPath))
			expect(readFileSync(pidPath, "utf8")).toBe(String(process.pid))
			expect(readdirSync(root)).toEqual(["maple.pid"])
		})
	})

	it("treats a PID reused by a process started after the write as stale", async () => {
		await withPidPath(async (pidPath) => {
			// After a reboot the old number can name a live, unrelated process.
			writeFileSync(pidPath, String(process.ppid))
			const longAgo = new Date("2001-01-01T00:00:00Z")
			utimesSync(pidPath, longAgo, longAgo)
			await Effect.runPromise(claimPidFileExclusive(pidPath))
			expect(readFileSync(pidPath, "utf8")).toBe(String(process.pid))
		})
	})

	it("hands a `start -d` parent's claim to its child", async () => {
		await withPidPath(async (pidPath) => {
			writeFileSync(pidPath, String(process.ppid))
			await Effect.runPromise(claimPidFileExclusive(pidPath, { handoverFrom: process.ppid }))
			expect(readFileSync(pidPath, "utf8")).toBe(String(process.pid))
		})
	})
})
