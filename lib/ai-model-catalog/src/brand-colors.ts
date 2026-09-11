// Brand colors for model vendors, keyed like the rest of the catalog by
// OpenRouter's author slug. A module of its own, off the package root, so a
// UI can take the colors without the generated model list behind `detect`.

/**
 * A brand's color on a light canvas and on a dark one. Most brands are one
 * color on both. Two kinds differ: a monochrome mark, which inverts on dark the
 * way the brand's own dark-mode logo does, and a bright brand color that washes
 * out on white, darkened there along its own hue. Every value holds 3:1 — the
 * bar for a non-text mark — against white and against a near-black canvas.
 */
export interface BrandColor {
	readonly light: string
	readonly dark: string
}

/** Black on light, white on dark: a brand whose mark has no color of its own. */
export const MONOCHROME: BrandColor = { light: "#000000", dark: "#FFFFFF" }

const same = (hex: string): BrandColor => ({ light: hex, dark: hex })

/**
 * Listed only where the brand has a color we can name with confidence. The
 * rest resolve to `null`: a neutral declines to name a brand, a near-miss names
 * the wrong one.
 */
export const AI_VENDOR_BRAND_COLORS = {
	amazon: { light: "#DC7900", dark: "#FF9900" },
	// Anthropic's accent, which is also the Claude mark's.
	anthropic: same("#D97757"),
	deepseek: same("#4D6BFE"),
	google: same("#4285F4"),
	"ibm-granite": same("#0F62FE"),
	meta: same("#0081FB"),
	"meta-llama": same("#0081FB"),
	microsoft: same("#0078D4"),
	mistralai: same("#FA520F"),
	nvidia: { light: "#64A600", dark: "#76B900" },
	openai: MONOCHROME,
	perplexity: same("#20808D"),
	"x-ai": MONOCHROME,
} satisfies Record<string, BrandColor>

const byVendor: Readonly<Record<string, BrandColor>> = AI_VENDOR_BRAND_COLORS

/** The brand color for a detected model's `vendorSlug`, or `null` when none is listed. */
export const aiVendorBrandColor = (vendorSlug: string | null): BrandColor | null =>
	// `hasOwn`, not a bare read: `constructor` is not a vendor.
	vendorSlug !== null && Object.hasOwn(byVendor, vendorSlug) ? (byVendor[vendorSlug] ?? null) : null
