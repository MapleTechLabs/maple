import { describe, expect, it } from "vitest"
import { redactText } from "./evidence-input"

describe("redactText", () => {
	it("takes out addresses, links and long tokens", () => {
		expect(
			redactText(
				" mail ada@acme.test, see https://acme.test/x?k=1 key abcdefghijklmnopqrstuvwxyz12 ",
				200,
			),
		).toBe("mail [email], see [url] key [token]")
	})

	it("drops a word the length cut split, so half an address never gets through unscrubbed", () => {
		// Cut at 20 characters: the address starts at 18 and would survive as "ad".
		const text = redactText(`${"word ".repeat(3)}xyz ada@acme.test and more text`, 10)
		expect(text).not.toContain("ad")
		expect(text).toBe("word word ")
	})
})
