import { describe, expect, it } from "vitest"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	DurableFileError,
	durableRenameSync,
	durableWrite,
	durableWriteFileSync,
	ensurePrivateDirectory,
} from "@maple/local-server/durable-files"

const withRoot = async (run: (root: string) => Promise<void>): Promise<void> => {
	const root = mkdtempSync(join(tmpdir(), "maple-durable-files-test-"))
	try {
		await run(root)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
}

const modeOf = (path: string): number => statSync(path).mode & 0o777

describe("durableWrite parent handling", () => {
	it("preserves the mode of an existing parent directory", async () => {
		await withRoot(async (root) => {
			// A caller-owned parent (e.g. /var/lib for --data-dir /var/lib/maple):
			// sibling markers/journals land here and must never re-permission it.
			const parent = join(root, "shared")
			mkdirSync(parent, { mode: 0o755 })
			await durableWrite(join(parent, "maple-store-version.json"), "{}\n")
			expect(modeOf(parent)).toBe(0o755)
		})
	})

	it("still creates a missing parent as private 0700", async () => {
		await withRoot(async (root) => {
			const parent = join(root, "created", "nested")
			await durableWrite(join(parent, "state.json"), "{}\n")
			expect(modeOf(parent)).toBe(0o700)
		})
	})

	it("ensurePrivateDirectory keeps hardening explicit Maple-owned roots", async () => {
		await withRoot(async (root) => {
			const owned = join(root, "backups")
			mkdirSync(owned, { mode: 0o755 })
			await ensurePrivateDirectory(owned)
			expect(modeOf(owned)).toBe(0o700)
		})
	})

	// Simulates a dir owned by another uid (bind mount, root-created volume).
	const chmodDenied = (): Promise<void> =>
		Promise.reject(Object.assign(new Error("EPERM: operation not permitted, chmod"), { code: "EPERM" }))

	it("ensurePrivateDirectory continues when chmod is denied on a writable owner-only directory", async () => {
		await withRoot(async (root) => {
			const foreign = join(root, "backups")
			mkdirSync(foreign, { mode: 0o700 })
			await ensurePrivateDirectory(foreign, chmodDenied)
			expect(modeOf(foreign)).toBe(0o700)
		})
	})

	it("ensurePrivateDirectory fails when chmod is denied on a group/other accessible directory", async () => {
		await withRoot(async (root) => {
			const foreign = join(root, "backups")
			mkdirSync(foreign)
			chmodSync(foreign, 0o755)
			await expect(ensurePrivateDirectory(foreign, chmodDenied)).rejects.toThrow(/group\/other/)
		})
	})

	it("ensurePrivateDirectory still fails when the denied directory is not writable", async () => {
		await withRoot(async (root) => {
			const readOnly = join(root, "backups")
			mkdirSync(readOnly, { mode: 0o500 })
			await expect(ensurePrivateDirectory(readOnly, chmodDenied)).rejects.toThrow(/EPERM/)
		})
	})
})

describe("synchronous durable helpers", () => {
	it("durableWriteFileSync creates a private file and truncates on rewrite", async () => {
		await withRoot(async (root) => {
			const path = join(root, "maple-store-open")
			durableWriteFileSync(path, "12345\n")
			expect(readFileSync(path, "utf8")).toBe("12345\n")
			expect(modeOf(path)).toBe(0o600)
			durableWriteFileSync(path, "7\n")
			expect(readFileSync(path, "utf8")).toBe("7\n")
		})
	})

	it("durableRenameSync moves a file and reports failures as DurableFileError", async () => {
		await withRoot(async (root) => {
			const from = join(root, "a")
			writeFileSync(from, "x")
			durableRenameSync(from, join(root, "b"))
			expect(existsSync(from)).toBe(false)
			expect(readFileSync(join(root, "b"), "utf8")).toBe("x")
			expect(() => durableRenameSync(join(root, "missing"), join(root, "c"))).toThrow(DurableFileError)
		})
	})
})
