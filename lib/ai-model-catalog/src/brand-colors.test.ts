import { describe, expect, it } from "vitest"
import { AI_VENDOR_BRAND_COLORS, MONOCHROME, aiVendorBrandColor } from "./brand-colors"
import { detectAiModel } from "./detect"

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

describe("aiVendorBrandColor", () => {
	it("resolves a detected model's vendor to its brand", () => {
		expect(aiVendorBrandColor(detectAiModel("claude-sonnet-4-5-20250929").vendorSlug)).toEqual({
			light: "#D97757",
			dark: "#D97757",
		})
		// Both of Meta's slugs are one brand.
		expect(aiVendorBrandColor("meta-llama")).toEqual(aiVendorBrandColor("meta"))
		expect(aiVendorBrandColor("openai")).toBe(MONOCHROME)
	})

	it("names no brand for an unlisted vendor, no vendor, or a prototype key", () => {
		expect(aiVendorBrandColor("z-ai")).toBeNull()
		expect(aiVendorBrandColor(null)).toBeNull()
		expect(aiVendorBrandColor("constructor")).toBeNull()
		expect(aiVendorBrandColor("__proto__")).toBeNull()
	})

	it("holds 3:1 on both canvases for every listed brand", () => {
		for (const [vendor, color] of Object.entries(AI_VENDOR_BRAND_COLORS)) {
			expect(contrast(color.light, "#FFFFFF"), `${vendor} on white`).toBeGreaterThanOrEqual(3)
			expect(contrast(color.dark, "#1E1B17"), `${vendor} on near-black`).toBeGreaterThanOrEqual(3)
		}
	})
})
