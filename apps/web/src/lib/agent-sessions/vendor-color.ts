import { AI_VENDOR_BRAND_COLORS, type BrandColor, MONOCHROME } from "@maple/ai-model-catalog/brand-colors"

/**
 * Brand colors for the vendor ids the ingest gateway stamps, the third of
 * `vendorIcon` and `vendorLabel`. A framework a model vendor publishes takes
 * that vendor's color from the catalog, so the Claude Agent SDK and a Claude
 * model agree; the rest are the frameworks' own, darkened on light or lifted on
 * dark where the brand color alone would not hold 3:1. Same rule as the icons:
 * a framework whose color we cannot name with confidence gets the neutral.
 */
const VENDOR_COLORS: Record<string, BrandColor> = {
	claude_agent_sdk: AI_VENDOR_BRAND_COLORS.anthropic,
	crewai: { light: "#FF5A50", dark: "#FF5A50" },
	effect_ai: MONOCHROME,
	// eve is Vercel's agent framework, and Vercel's brand is black and white.
	eve: MONOCHROME,
	google_adk: AI_VENDOR_BRAND_COLORS.google,
	langchain: { light: "#1C3C3C", dark: "#5A7C7B" },
	// Maple's own amber, which the theme already resolves per canvas.
	maple: { light: "var(--primary)", dark: "var(--primary)" },
	microsoft_agent_framework: AI_VENDOR_BRAND_COLORS.microsoft,
	openai_agents_sdk: AI_VENDOR_BRAND_COLORS.openai,
	"openinference-openai": AI_VENDOR_BRAND_COLORS.openai,
	pydantic_ai: { light: "#E92063", dark: "#E92063" },
	semantic_kernel: AI_VENDOR_BRAND_COLORS.microsoft,
	// Hugging Face's yellow.
	smolagents: { light: "#BA8E00", dark: "#FFD21E" },
	spring_ai: { light: "#5EA32D", dark: "#6DB33F" },
	vercel_ai_sdk: MONOCHROME,
} satisfies Record<string, BrandColor>

const NEUTRAL = "var(--muted-foreground)"

/**
 * The CSS color for `vendorLabel(vendorId)`'s brand — a `light-dark()` pair
 * where the canvases differ, which resolves against the `color-scheme` the
 * theme pins. Tint with `color-mix()`, never hex-alpha concatenation.
 */
export function vendorColor(vendorId: string): string {
	const brand = VENDOR_COLORS[vendorId]
	if (brand === undefined) return NEUTRAL
	return brand.light === brand.dark ? brand.light : `light-dark(${brand.light}, ${brand.dark})`
}
