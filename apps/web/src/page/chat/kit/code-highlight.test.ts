import { describe, expect, it } from "vitest"
import { highlight } from "./code-highlight"

const types = (language: string, code: string) =>
	highlight(language, code).lines.map((line) => line.map((token) => [token.type, token.content]))

describe("highlight", () => {
	it("tokenizes a fence by its language, resolving aliases", () => {
		expect(types("SQL", "SELECT a -- c")).toEqual([
			[
				["keyword", "SELECT"],
				["space", " "],
				["identifier", "a"],
				["space", " "],
				["comment", "-- c"],
			],
		])
		expect(types("py", "def f(): pass")[0]?.[0]).toEqual(["keyword", "def"])
	})

	it("keeps an unknown language as plain text, one line per source line", () => {
		expect(types("brainfuck", "if x\n\nreturn")).toEqual([
			[["identifier", "if x"]],
			[],
			[["identifier", "return"]],
		])
	})
})
