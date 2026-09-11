/** A brand's color on the light canvas and on the dark one. */
interface BrandColor {
	readonly light: string
	readonly dark: string
}

/** Black on light, white on dark: a brand whose mark has no color of its own. */
const MONOCHROME: BrandColor = { light: "#000000", dark: "#FFFFFF" }

/**
 * Brand colors for the vendor ids the ingest gateway stamps, the third of
 * `vendorIcon` and `vendorLabel`. A framework a model vendor publishes wears
 * that vendor's color, so the Claude Agent SDK and a Claude model agree; the
 * rest are the frameworks' own, darkened on light or lifted on dark where the
 * brand color alone would not hold 3:1. Same rule as the icons: a framework
 * whose color we cannot name with confidence gets the neutral.
 */
const VENDOR_COLORS = {
	// Anthropic's, as `VENDOR_BRAND_COLORS` in lib/ai-model-catalog lists it.
	claude_agent_sdk: { light: "#D97757", dark: "#D97757" },
	crewai: { light: "#FF5A50", dark: "#FF5A50" },
	effect_ai: MONOCHROME,
	// eve is Vercel's agent framework, and Vercel's brand is black and white.
	eve: MONOCHROME,
	// Google's, as `VENDOR_BRAND_COLORS` in lib/ai-model-catalog lists it.
	google_adk: { light: "#4285F4", dark: "#4285F4" },
	langchain: { light: "#1C3C3C", dark: "#5A7C7B" },
	// Maple's own amber, which the theme already resolves per canvas.
	maple: { light: "var(--primary)", dark: "var(--primary)" },
	// Microsoft's, as `VENDOR_BRAND_COLORS` in lib/ai-model-catalog lists it.
	microsoft_agent_framework: { light: "#0078D4", dark: "#0078D4" },
	// OpenAI's, as `VENDOR_BRAND_COLORS` in lib/ai-model-catalog lists it.
	openai_agents_sdk: MONOCHROME,
	"openinference-openai": MONOCHROME,
	pydantic_ai: { light: "#E92063", dark: "#E92063" },
	// Microsoft's, as `VENDOR_BRAND_COLORS` in lib/ai-model-catalog lists it.
	semantic_kernel: { light: "#0078D4", dark: "#0078D4" },
	// Hugging Face's yellow.
	smolagents: { light: "#BA8E00", dark: "#FFD21E" },
	spring_ai: { light: "#5EA32D", dark: "#6DB33F" },
	vercel_ai_sdk: MONOCHROME,
} satisfies Record<string, BrandColor>

const NEUTRAL = "var(--muted-foreground)"

// `hasOwn`, not a bare read: an ingested `constructor` is not a vendor.
const isListedVendor = (vendorId: string): vendorId is keyof typeof VENDOR_COLORS =>
	Object.hasOwn(VENDOR_COLORS, vendorId)

/**
 * The CSS color for `vendorLabel(vendorId)`'s brand — a `light-dark()` pair
 * where the canvases differ, which resolves against the `color-scheme` the
 * theme pins. Tint with `color-mix()`, never hex-alpha concatenation.
 */
export function vendorColor(vendorId: string): string {
	if (!isListedVendor(vendorId)) return NEUTRAL
	const brand: BrandColor = VENDOR_COLORS[vendorId]
	return brand.light === brand.dark ? brand.light : `light-dark(${brand.light}, ${brand.dark})`
}
