import type { IconName } from "../../../ui/icon"

export { modelVendorColor, vendorColor } from "../../../lib/agent-sessions/vendor-color"
export { vendorLabel } from "../../../lib/agent-sessions/vendor-label"

// The vendor and model-vendor icon maps, as icon names.

const VENDOR_ICONS = new Map<string, IconName>([
	["claude_agent_sdk", "ClaudeIcon"],
	["cloudflare_ai_gateway", "CloudflareBrandIcon"],
	["crewai", "CrewAiIcon"],
	["effect_ai", "EffectIcon"],
	["eve", "VercelIcon"],
	["google_adk", "GoogleIcon"],
	["haystack", "HaystackIcon"],
	["langchain", "LangchainIcon"],
	["maple", "MapleMark"],
	["microsoft_agent_framework", "MicrosoftIcon"],
	["openai_agents_sdk", "OpenAiIcon"],
	["openinference-openai", "OpenAiIcon"],
	["openrouter", "OpenRouterIcon"],
	["pydantic_ai", "PydanticIcon"],
	["semantic_kernel", "MicrosoftIcon"],
	["smolagents", "HuggingFaceIcon"],
	["spring_ai", "SpringIcon"],
	["vercel_ai_sdk", "VercelIcon"],
])

/** The mark beside `vendorLabel(vendorId)`. */
export const vendorIcon = (vendorId: string): IconName =>
	VENDOR_ICONS.get(vendorId) ?? "ChatBubbleSparkleIcon"

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

/** `modelVendorIcon`: family first, then vendor, then the generic mark. */
export const modelVendorIcon = (detected: {
	readonly vendorSlug: string | null
	readonly family: string | null
}): IconName =>
	(detected.family === null ? undefined : FAMILY_ICONS.get(detected.family)) ??
	(detected.vendorSlug === null ? undefined : MODEL_VENDOR_ICONS.get(detected.vendorSlug)) ??
	"ChatBubbleSparkleIcon"
