import { Effect, Array as Arr, String as Str } from "effect"
import { describe, expect, test } from "vitest"
import { escapeDirectives, parseMarkdownTexts } from "./markdown"

const parse = (text: string) => Effect.runPromise(parseMarkdownTexts([text])).then(([parsed]) => parsed)

describe("the shared markdown parse", () => {
	test("prose with a clock time parses instead of being rejected as a directive", async () => {
		const parsed = await parse("The deploy finished at 14:03 and the retry ran at 14:05:12.")
		expect(parsed?.document).not.toBeNull()
		expect(JSON.stringify(parsed?.document)).toContain("14:03")
	})

	test("code spans and fenced blocks keep their colons as written", () => {
		const text = Arr.join(
			["key:value in `a:b` prose", "```yaml", "image:latest", "```", "after:fence"],
			"\n",
		)
		expect(Str.split("\n")(escapeDirectives(text))).toEqual([
			"key\\:value in `a:b` prose",
			"```yaml",
			"image:latest",
			"```",
			"after\\:fence",
		])
	})
})
