import { describe, expect, it } from "vitest"
import { highlight } from "./code-highlight"

const slots = (language: string, code: string) =>
	highlight(language, code).lines.map((line) => line.map((token) => [token.slot, token.content]))

describe("highlight", () => {
	it("tokenizes a fence by its language, resolving aliases and case", () => {
		const sql = slots("SQL", "SELECT a -- c")[0] ?? []
		expect(sql[0]).toEqual(["keyword", "SELECT "])
		expect(sql.at(-1)).toEqual(["comment", "-- c"])
		expect(slots("py", "def f(): pass")[0]?.[0]).toEqual(["keyword", "def "])
	})

	it("keeps an unknown language as plain text, one line per source line", () => {
		expect(slots("brainfuck", "if x\n\nreturn")).toEqual([
			[["foreground", "if x"]],
			[],
			[["foreground", "return"]],
		])
	})
})
