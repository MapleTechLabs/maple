import { describe, expect, test } from "bun:test"
import { openHandoff, sealHandoff } from "./preview-handoff.ts"

const handoff = { host: "https://tb.example", id: "branch-id", token: "branch-token" }

describe("preview Tinybird handoff", () => {
	test("opens with the same secret and branch name", async () => {
		const sealed = await sealHandoff("secret", "pr_7", handoff)
		expect(sealed).not.toContain("branch-token")
		expect(await openHandoff("secret", "pr_7", sealed)).toEqual(handoff)
	})

	test("does not open for another PR's branch or with another secret", async () => {
		const sealed = await sealHandoff("secret", "pr_7", handoff)
		expect(await openHandoff("secret", "pr_8", sealed)).toBeUndefined()
		expect(await openHandoff("other", "pr_7", sealed)).toBeUndefined()
	})

	test("rejects a tampered or truncated payload", async () => {
		const raw = Buffer.from(await sealHandoff("secret", "pr_7", handoff), "base64")
		raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 1
		expect(await openHandoff("secret", "pr_7", raw.toString("base64"))).toBeUndefined()
		expect(await openHandoff("secret", "pr_7", "AAAA")).toBeUndefined()
	})
})
