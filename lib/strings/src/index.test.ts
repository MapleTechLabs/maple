import { describe, expect, it } from "vitest"
import { pipe, Array as Arr, String as Str } from "effect"
import { codePointAt, codeUnitAt, indexOfFrom, matchAllIndexed, replaceWith } from "./index"

describe("replaceWith", () => {
	it("passes capture groups and replaces every match of a global regex", () => {
		expect(
			pipe(
				"max_age_seconds",
				replaceWith(/_([a-z])/g, (_, c = "") => Str.toUpperCase(c)),
			),
		).toBe("maxAgeSeconds")
	})

	it("replaces only the first match without the global flag", () => {
		expect(replaceWith("a-a-a", "-", () => "+")).toBe("a+a-a")
	})

	it("gives an unmatched optional group as undefined, not the offset", () => {
		const seen: Array<unknown> = []
		replaceWith("x1 y", /([a-z])(\d)?/g, (match, letter, digit) => {
			seen.push([match, letter, digit])
			return match
		})
		expect(seen).toEqual([
			["x1", "x", "1"],
			["y", "y", undefined],
		])
	})

	it("drops the named-groups object a native replacer receives", () => {
		expect(
			replaceWith(
				"k=v",
				/(?<key>\w)=(?<value>\w)/,
				(_, key, value, ...rest) => `${value}=${key}${rest.length}`,
			),
		).toBe("v=k0")
	})
})

describe("position reads", () => {
	it("indexOfFrom searches from the given offset", () => {
		expect(indexOfFrom("abcabc", "a", 1)).toBe(3)
		expect(pipe("abc", indexOfFrom("a", 1))).toBe(-1)
	})

	it("codeUnitAt and codePointAt read numbers without an Option", () => {
		expect(codeUnitAt("A", 0)).toBe(65)
		expect(Number.isNaN(codeUnitAt("A", 3))).toBe(true)
		expect(codePointAt("😀", 0)).toBe(0x1f600)
		expect(codePointAt("", 0)).toBe(0)
	})

	it("matchAllIndexed returns each match with its index", () => {
		expect(Arr.map(matchAllIndexed("a1b22", /\d+/g), (m) => [m[0], m.index])).toEqual([
			["1", 1],
			["22", 3],
		])
	})
})
