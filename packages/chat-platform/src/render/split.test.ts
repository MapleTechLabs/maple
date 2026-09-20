import { describe, expect, it } from "vitest"
import type { ChatBlock } from "./blocks"
import { cutMarkdown, splitBlocks } from "./split"

const prose = (markdown: string): ChatBlock => ({ kind: "prose", markdown })

const notice: ChatBlock = { kind: "notice", tone: "info", text: "Stopped before finishing." }

describe("splitBlocks", () => {
	it("keeps a turn that fits in one message", () => {
		const blocks = [prose("short"), notice]
		expect(splitBlocks(blocks, 100)).toEqual([blocks])
	})

	it("starts a message rather than filling the tail of one with half a paragraph", () => {
		const groups = splitBlocks([prose("a".repeat(30)), prose("b".repeat(30))], 40)
		expect(groups).toEqual([[prose("a".repeat(30))], [prose("b".repeat(30))]])
	})

	it("carries a turn with nothing in it, so an emptied message still has a group", () => {
		expect(splitBlocks([], 100)).toEqual([[]])
	})

	it("holds every group to the budget", () => {
		const groups = splitBlocks([prose("word ".repeat(200).trim()), notice], 200)
		for (const group of groups) {
			const spent = group.reduce(
				(total, block) =>
					total +
					(block.kind === "prose"
						? block.markdown.length
						: block.kind === "notice"
							? block.text.length
							: 0),
				0,
			)
			expect(spent).toBeLessThanOrEqual(200)
		}
	})
})

describe("cutMarkdown", () => {
	it("cuts on line boundaries", () => {
		expect(cutMarkdown("one\ntwo\nthree", 8)).toEqual(["one\ntwo", "three"])
	})

	it("closes a fence it has to cut through, and reopens it", () => {
		const fenced = ["```ts", "const a = 1", "const b = 2", "const c = 3", "```"].join("\n")
		const chunks = cutMarkdown(fenced, 30)

		expect(chunks.length).toBeGreaterThan(1)
		// Unclosed fences render the rest of a message as code on every platform that has them.
		for (const chunk of chunks) expect(countFences(chunk) % 2).toBe(0)
		expect(chunks[1].startsWith("```ts")).toBe(true)
	})

	it("cuts a line that is longer than a whole message", () => {
		const chunks = cutMarkdown("x".repeat(250), 100)
		expect(chunks.map((chunk) => chunk.length)).toEqual([100, 100, 50])
		expect(chunks.join("")).toBe("x".repeat(250))
	})
})

const countFences = (text: string): number =>
	text.split("\n").filter((line) => line.trimStart().startsWith("```")).length
