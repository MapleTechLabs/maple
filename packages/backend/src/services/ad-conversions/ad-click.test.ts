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

	it("keeps forged or stale input only as a capped raw string", () => {
		const forged = decodeAdClick({ adClick: { ...click, id: `=cmd|${Str.repeat(1000)("x")}` } }, NOW)
		expect(forged._tag).toBe("Invalid")
		expect(forged._tag === "Invalid" && forged.rawAdClick.length).toBe(300)
		expect(decodeAdClick({ adClick: { ...click, type: "fbclid" } }, NOW)._tag).toBe("Invalid")
		expect(decodeAdClick({ adClick: { ...click, clickTime: NOW - 91 * DAY } }, NOW)._tag).toBe("Invalid")
		expect(decodeAdClick({ adClick: { ...click, clickTime: NOW + DAY } }, NOW)._tag).toBe("Invalid")
	})

	it("pulls a click a little ahead of our clock back to it", () => {
		expect(decodeAdClick({ adClick: { ...click, clickTime: NOW + 60_000 } }, NOW)).toEqual({
			_tag: "Valid",
			click: { ...click, clickTime: NOW },
		})
	})
})
