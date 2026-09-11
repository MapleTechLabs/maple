import { describe, expect, it } from "vitest"
import { VENDOR_BRAND_COLORS } from "./vendors"

/** WCAG relative luminance of a `#RRGGBB` color. */
const luminance = (hex: string): number => {
	const [r, g, b] = [1, 3, 5].map((index) => {
		const channel = Number.parseInt(hex.slice(index, index + 2), 16) / 255
		return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
	})
	return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

const contrast = (a: string, b: string): number => {
	const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x)
	return (lighter + 0.05) / (darker + 0.05)
}

describe("VENDOR_BRAND_COLORS", () => {
	it("holds 3:1 on both canvases for every listed brand", () => {
		for (const [vendor, color] of Object.entries(VENDOR_BRAND_COLORS)) {
			expect(contrast(color.light, "#FFFFFF"), `${vendor} on white`).toBeGreaterThanOrEqual(3)
			expect(contrast(color.dark, "#1E1B17"), `${vendor} on near-black`).toBeGreaterThanOrEqual(3)
		}
	})

	it("gives both of a vendor's slugs one brand", () => {
		expect(VENDOR_BRAND_COLORS["meta-llama"]).toEqual(VENDOR_BRAND_COLORS.meta)
	})
})
