import { assert, describe, it } from "@effect/vitest"
import { buildChatDigestBlocks, type ChatDigestItem } from "./chat-digest"

const item = (n: number): ChatDigestItem => ({
	ruleName: `Rule [${n}]`,
	eventType: "trigger",
	severity: n === 1 ? "critical" : "warning",
	groupKey: "checkout",
	linkUrl: `https://app.test/services/checkout?n=${n}`,
})

describe("buildChatDigestBlocks", () => {
	it("lists each alert with its link, then counts the ones past the cap", () => {
		const [card] = buildChatDigestBlocks(
			Array.from({ length: 12 }, (_, i) => item(i + 1)),
			"https://app.test/alerts",
			0,
		)
		assert.strictEqual(card?.kind, "alert")
		if (card?.kind !== "alert") return
		const lines = card.summary.split("\n")
		assert.lengthOf(lines, 11)
		assert.include(lines[0], "[Rule 1](https://app.test/services/checkout?n=1)")
		assert.include(lines[0], "Critical")
		assert.strictEqual(lines[10], "…and 2 more")
		assert.include(card.title, "12 alert notifications")
	})
})
