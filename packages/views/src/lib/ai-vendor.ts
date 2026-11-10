import { Array as Arr, Record as Rec, String as Str } from "effect"
import type { IconName } from "../ui/icon"

// The AI vendors the ingest gateway stamps (`AI_VENDORS` in apps/ingest/src/ai_session.rs): one record
// per vendor id with its label, mark and brand colour, each optional.

/** A brand's color on the light canvas and on the dark one. */
interface BrandColor {
	readonly light: string
	readonly dark: string
}

interface Vendor {
	/** Only where the title-case fallback can't derive the casing (SDK, LiteLLM, smolagents). */
	readonly label?: string
	readonly icon?: IconName
	/**
	 * A framework a model vendor publishes wears that vendor's color, so the Claude Agent SDK and a
	 * Claude model agree; one whose color we cannot name with confidence gets the neutral.
	 */
	readonly color?: BrandColor
}

/** Black on light, white on dark: a brand whose mark has no color of its own. */
const MONOCHROME: BrandColor = { light: "#000000", dark: "#FFFFFF" }
// Anthropic's, Google's and Microsoft's, as `VENDOR_BRAND_COLORS` in lib/ai-model-catalog lists them.
const ANTHROPIC: BrandColor = { light: "#D97757", dark: "#D97757" }
const GOOGLE: BrandColor = { light: "#4285F4", dark: "#4285F4" }
const MICROSOFT: BrandColor = { light: "#0078D4", dark: "#0078D4" }

const VENDORS = {
	claude_agent_sdk: { label: "Claude Agent SDK", icon: "ClaudeIcon", color: ANTHROPIC },
	cloudflare_ai_gateway: {
		label: "Cloudflare AI Gateway",
		icon: "CloudflareBrandIcon",
		// Cloudflare's orange.
		color: { light: "#F38020", dark: "#F38020" },
	},
	crewai: { label: "CrewAI", icon: "CrewAiIcon", color: { light: "#FF5A50", dark: "#FF5A50" } },
	dspy: { label: "DSPy" },
	effect_ai: { label: "Effect AI", icon: "EffectIcon", color: MONOCHROME },
	// eve is Vercel's agent framework, and Vercel's brand is black and white.
	eve: { label: "eve", icon: "VercelIcon", color: MONOCHROME },
	google_adk: { label: "Google ADK", icon: "GoogleIcon", color: GOOGLE },
	haystack: { icon: "HaystackIcon" },
	langchain: { label: "LangChain", icon: "LangchainIcon", color: { light: "#1C3C3C", dark: "#5A7C7B" } },
	litellm: { label: "LiteLLM" },
	llamaindex: { label: "LlamaIndex" },
	// Maple's own amber, which the theme already resolves per canvas.
	maple: { icon: "MapleMark", color: { light: "var(--primary)", dark: "var(--primary)" } },
	microsoft_agent_framework: { icon: "MicrosoftIcon", color: MICROSOFT },
	openai_agents_sdk: { label: "OpenAI Agents SDK", icon: "OpenAiIcon", color: MONOCHROME },
	"openinference-openai": { label: "OpenInference · OpenAI", icon: "OpenAiIcon", color: MONOCHROME },
	openrouter: { label: "OpenRouter", icon: "OpenRouterIcon" },
	pydantic_ai: { label: "Pydantic AI", icon: "PydanticIcon", color: { light: "#E92063", dark: "#E92063" } },
	semantic_kernel: { icon: "MicrosoftIcon", color: MICROSOFT },
	// Hugging Face's yellow.
	smolagents: {
		label: "smolagents",
		icon: "HuggingFaceIcon",
		color: { light: "#BA8E00", dark: "#FFD21E" },
	},
	spring_ai: { label: "Spring AI", icon: "SpringIcon", color: { light: "#5EA32D", dark: "#6DB33F" } },
	vercel_ai_sdk: { label: "Vercel AI SDK", icon: "VercelIcon", color: MONOCHROME },
} satisfies Record<string, Vendor>

// `hasOwn`, not a bare read: an ingested `constructor` is not a vendor.
const isListedVendor = (vendorId: string): vendorId is keyof typeof VENDORS =>
	Rec.has<string, Vendor>(VENDORS, vendorId)

const vendorOf = (vendorId: string): Vendor | undefined =>
	isListedVendor(vendorId) ? VENDORS[vendorId] : undefined

/** The gateway's marker for "no vendor matched" (`UNKNOWN_TIER`). */
const UNIDENTIFIED_PREFIX = "unknown:"

/**
 * A vendor id as a reader should see it. Unlisted ids degrade to Title Case, so
 * a newly stamped vendor still reads as a name rather than a raw id.
 */
export function vendorLabel(vendorId: string): string {
	if (!vendorId || Str.startsWith(UNIDENTIFIED_PREFIX)(vendorId)) return "Unidentified"
	const known = vendorOf(vendorId)?.label
	if (known) return known
	return Arr.join(
		Arr.map(
			Arr.filter(Str.split(/[_-]+/)(vendorId), Boolean),
			(word) => Str.toUpperCase(Str.slice(0, 1)(word)) + Str.slice(1)(word),
		),
		" ",
	)
}

/** The mark beside `vendorLabel(vendorId)`. */
export const vendorIcon = (vendorId: string): IconName => vendorOf(vendorId)?.icon ?? "ChatBubbleSparkleIcon"

const NEUTRAL = "var(--muted-foreground)"

/**
 * A brand as one CSS color: a `light-dark()` pair where the canvases differ,
 * which resolves against the `color-scheme` the theme pins. Tint with
 * `color-mix()`, never hex-alpha concatenation.
 */
const brandColorCss = (brand: BrandColor): string =>
	brand.light === brand.dark ? brand.light : `light-dark(${brand.light}, ${brand.dark})`

/** The CSS color for `vendorLabel(vendorId)`'s brand; see `brandColorCss`. */
export function vendorColor(vendorId: string): string {
	const color = vendorOf(vendorId)?.color
	return color === undefined ? NEUTRAL : brandColorCss(color)
}

const MODEL_VENDOR_ICONS = new Map<string, IconName>([
	["aion-labs", "AionLabsIcon"],
	["amazon", "AmazonIcon"],
	["anthropic", "AnthropicIcon"],
	["arcee-ai", "ArceeIcon"],
	["baidu", "BaiduIcon"],
	["bytedance", "ByteDanceIcon"],
	["bytedance-seed", "ByteDanceIcon"],
	["cognitivecomputations", "VeniceIcon"],
	["cohere", "CohereIcon"],
	["deepseek", "DeepSeekIcon"],
	["google", "GoogleIcon"],
	["ibm-granite", "IbmIcon"],
	["inception", "InceptionIcon"],
	["kwaipilot", "KwaipilotIcon"],
	["liquid", "LiquidIcon"],
	["meituan", "MeituanIcon"],
	["meta", "MetaIcon"],
	["meta-llama", "MetaIcon"],
	["microsoft", "MicrosoftIcon"],
	["minimax", "MiniMaxIcon"],
	["mistralai", "MistralIcon"],
	["moonshotai", "MoonshotIcon"],
	["morph", "MorphIcon"],
	["nousresearch", "NousResearchIcon"],
	["nvidia", "NvidiaIcon"],
	["openai", "OpenAiIcon"],
	["openrouter", "OpenRouterIcon"],
	["perplexity", "PerplexityIcon"],
	["poolside", "PoolsideIcon"],
	["qwen", "QwenIcon"],
	["relace", "RelaceIcon"],
	["stepfun", "StepFunIcon"],
	["tencent", "TencentIcon"],
	["upstage", "UpstageIcon"],
	["x-ai", "XaiIcon"],
	["z-ai", "ZaiIcon"],
])

const FAMILY_ICONS = new Map<string, IconName>([
	["claude", "ClaudeIcon"],
	["gemini", "GeminiIcon"],
	["grok", "GrokIcon"],
	["kimi", "KimiIcon"],
])

/** A detected model's mark: family first, then vendor, then the generic mark. */
export const modelVendorIcon = (detected: {
	readonly vendorSlug: string | null
	readonly family: string | null
}): IconName =>
	(detected.family === null ? undefined : FAMILY_ICONS.get(detected.family)) ??
	(detected.vendorSlug === null ? undefined : MODEL_VENDOR_ICONS.get(detected.vendorSlug)) ??
	"ChatBubbleSparkleIcon"

/**
 * The CSS color for `modelVendorIcon(detected)`'s mark, from the brand the detect endpoint
 * returns. `undefined` where it lists none, not the neutral: an unbranded model mark keeps
 * the color of the text it labels.
 */
export function modelVendorColor(detected: { readonly brandColor: BrandColor | null }): string | undefined {
	return detected.brandColor === null ? undefined : brandColorCss(detected.brandColor)
}
