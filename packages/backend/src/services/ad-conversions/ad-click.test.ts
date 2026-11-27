import { String as Str } from "effect"
import { describe, expect, it } from "vitest"
import { decodeAdClick } from "./ad-click"

const NOW = 1_764_000_000_000
const DAY = 86_400_000
const click = { type: "gclid", id: "Cj0K_x-9", clickTime: NOW - DAY }

describe("decodeAdClick", () => {
	it("reads a click from the sign-up's metadata", () => {
		expect(decodeAdClick({ adClick: click, other: 1 }, NOW)).toEqual({ _tag: "Valid", click })
	})

	it("is absent when the sign-up carried no click", () => {
		expect(decodeAdClick(undefined, NOW)).toEqual({ _tag: "Absent" })
		expect(decodeAdClick({}, NOW)).toEqual({ _tag: "Absent" })
		expect(decodeAdClick("not an object", NOW)).toEqual({ _tag: "Absent" })
	})

	it("rejects forged or stale input with a reason and keeps none of it", () => {
		const unreadable = { _tag: "Invalid", reason: "invalid_shape" }
		const expired = { _tag: "Invalid", reason: "outside_window" }
		expect(decodeAdClick({ adClick: { ...click, id: `=cmd|${Str.repeat(1000)("x")}` } }, NOW)).toEqual(
			shape,
		)
		expect(decodeAdClick({ adClick: { ...click, type: "fbclid" } }, NOW)).toEqual(unreadable)
		expect(decodeAdClick({ adClick: { ...click, clickTime: NOW - 91 * DAY } }, NOW)).toEqual(expired)
		expect(decodeAdClick({ adClick: { ...click, clickTime: NOW + DAY } }, NOW)).toEqual(expired)
	})

	it("pulls a click a little ahead of our clock back to it", () => {
		expect(decodeAdClick({ adClick: { ...click, clickTime: NOW + 60_000 } }, NOW)).toEqual({
			_tag: "Valid",
			click: { ...click, clickTime: NOW },
		})
	})
})
