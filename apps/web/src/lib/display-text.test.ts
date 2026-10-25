import { Option } from "effect"
import { describe, expect, test } from "vitest"
import { capForDisplay, DISPLAY_MAX_CHARS, headLines, memoizeByText, prettyJson } from "./display-text"

describe("prettyJson", () => {
	test("re-indents an object and ignores anything that is not an object or array", () => {
		expect([prettyJson('{"a":1}'), prettyJson("plain text"), prettyJson("{broken")]).toEqual([
			Option.some('{\n  "a": 1\n}'),
			Option.none(),
			Option.none(),
		])
	})
})

describe("memoizeByText", () => {
	test("a long input is computed once across repeated calls; a short one every time", () => {
		const calls: Array<number> = []
		const measure = memoizeByText((input) => {
			calls.push(input.length)
			return input.length
		})
		const long = "x".repeat(DISPLAY_MAX_CHARS)
		;[long, long, "short", "short"].forEach((input) => measure(input))
		expect(calls).toEqual([DISPLAY_MAX_CHARS, 5, 5])
	})
})

describe("capForDisplay", () => {
	test("keeps short text whole and cuts long text to the limit, counting the rest", () => {
		const long = "y".repeat(DISPLAY_MAX_CHARS + 123)
		const { shown, omitted } = capForDisplay(long)
		expect([capForDisplay("short").omitted, shown.length, omitted]).toEqual([0, DISPLAY_MAX_CHARS, 123])
	})
})

describe("headLines", () => {
	test("returns the first lines, or all of a shorter text", () => {
		expect([headLines("a\nb\nc\nd", 2), headLines("a\nb", 6), headLines("one line", 1)]).toEqual([
			"a\nb",
			"a\nb",
			"one line",
		])
	})
})
