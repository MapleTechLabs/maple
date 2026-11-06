import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { String as Str } from "effect"
import { ensureLocalToken, notPrivateReason } from "@maple/local-server/local-token"

const TOKEN = Str.repeat(64)("a")
const failure = (path: string) =>
	ensureLocalToken(path, "maintenance token").then(
		() => undefined,
		(error: unknown) => error,
	)
let root = ""

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "maple-local-token-"))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe.skipIf(process.platform === "win32")("local credential files", () => {
	test("creates a missing token private to this user and reads it back unchanged", async () => {
		const path = join(root, "data.maintenance-token")
		const token = await ensureLocalToken(path, "maintenance token")
		expect(token).toMatch(/^[0-9a-f]{64}$/)
		expect(statSync(path).mode & 0o777).toBe(0o600)
		expect(await ensureLocalToken(path, "maintenance token")).toBe(token)
	})

	test("refuses an existing token that group or other can access", async () => {
		const path = join(root, "data.maintenance-token")
		writeFileSync(path, `${TOKEN}\n`, { mode: 0o600 })
		expect(await ensureLocalToken(path, "maintenance token")).toBe(TOKEN)
		for (const mode of [0o640, 0o604, 0o666]) {
			chmodSync(path, mode)
			expect(await failure(path)).toMatchObject({
				_tag: "@maple/cli/LocalFileNotPrivate",
				message: expect.stringContaining(`has mode ${mode.toString(8)}`),
			})
		}
	})

	test("refuses a symlink and a FIFO without following or blocking on them", async () => {
		const target = join(root, "target")
		writeFileSync(target, `${TOKEN}\n`, { mode: 0o600 })
		const link = join(root, "link-token")
		symlinkSync(target, link)
		expect(await failure(link)).toMatchObject({
			_tag: "@maple/cli/LocalFileNotReal",
		})
		const fifo = join(root, "fifo-token")
		execFileSync("mkfifo", ["-m", "600", fifo])
		expect(await failure(fifo)).toMatchObject({
			_tag: "@maple/cli/LocalFileNotReal",
		})
	})

	test("names a file owned by another user", () => {
		expect(notPrivateReason({ uid: 501, mode: 0o100600 }, 501)).toBeUndefined()
		expect(notPrivateReason({ uid: 502, mode: 0o100600 }, 501)).toBe(
			"is owned by uid 502, not this user (uid 501)",
		)
		expect(notPrivateReason({ uid: 502, mode: 0o100644 }, undefined)).toBeUndefined()
	})
})
