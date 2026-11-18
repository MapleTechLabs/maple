import { Option } from "effect"
import { describe, expect, it } from "vitest"
import { hexToHsv, hsvToHex, normalizeHex } from "./color-hsv"

describe("normalizeHex", () => {
	it("expands short hex, adds the hash and lower-cases", () => {
		expect(normalizeHex("ABC")).toEqual(Option.some("#aabbcc"))
		expect(normalizeHex(" #EF4444 ")).toEqual(Option.some("#ef4444"))
	})

	it("rejects partial and non-hex input", () => {
		expect(normalizeHex("#ef44")).toEqual(Option.none())
		expect(normalizeHex("#gggggg")).toEqual(Option.none())
		expect(normalizeHex("red")).toEqual(Option.none())
		expect(normalizeHex("")).toEqual(Option.none())
	})
})

describe("hsvToHex", () => {
	it("draws the primaries and the hue wheel's ends", () => {
		expect(hsvToHex({ hue: 0, saturation: 1, value: 1 })).toBe("#ff0000")
		expect(hsvToHex({ hue: 120, saturation: 1, value: 1 })).toBe("#00ff00")
		expect(hsvToHex({ hue: 240, saturation: 1, value: 1 })).toBe("#0000ff")
		expect(hsvToHex({ hue: 360, saturation: 1, value: 1 })).toBe("#ff0000")
	})

	it("clamps saturation and value into range", () => {
		expect(hsvToHex({ hue: 30, saturation: -1, value: 2 })).toBe("#ffffff")
		expect(hsvToHex({ hue: 30, saturation: 1, value: -0.5 })).toBe("#000000")
	})
})

describe("hexToHsv", () => {
	it("round-trips colours through HSV", () => {
		for (const hex of ["#ef4444", "#22c55e", "#3b82f6", "#a855f7", "#f59e0b", "#0f172a", "#808080"]) {
			const hsv = Option.getOrThrow(hexToHsv(hex))
			expect(hsvToHex(hsv)).toBe(hex)
		}
	})

	it("reads hue, saturation and value", () => {
		expect(hexToHsv("#ff00ff")).toEqual(Option.some({ hue: 300, saturation: 1, value: 1 }))
		expect(hexToHsv("#800000")).toEqual(
			Option.some({ hue: 0, saturation: 1, value: 128 / 255 }),
		)
	})

	it("keeps the previous hue for a grey and the previous saturation for black", () => {
		const previous = { hue: 210, saturation: 0.6, value: 0.8 }
		expect(Option.map(hexToHsv("#777777", previous), (hsv) => hsv.hue)).toEqual(Option.some(210))
		expect(hexToHsv("#000000", previous)).toEqual(Option.some({ hue: 210, saturation: 0.6, value: 0 }))
	})

	it("is none for a value that is not hex", () => {
		expect(hexToHsv("var(--color-primary)")).toEqual(Option.none())
	})
})
