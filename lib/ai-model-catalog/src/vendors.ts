// Vendor knowledge the OpenRouter list does not carry: naming corrections,
// labs that only ever appear in raw provider model ids, and the prefix rules
// that place such an id with a vendor when no catalog entry matches it.

/**
 * Display names for vendor slugs, layered over `OPENROUTER_VENDORS`. Listed
 * here: the slugs OpenRouter labels oddly (`x-ai` is "SpaceXAI" there) and
 * the labs the prefix rules below can name that OpenRouter does not list.
 */
export const VENDOR_NAME_OVERRIDES: Readonly<Record<string, string>> = {
	"01-ai": "01.AI",
	ai21: "AI21",
	databricks: "Databricks",
	"ibm-granite": "IBM",
	inflection: "Inflection",
	"meta-llama": "Meta",
	rekaai: "Reka",
	tiiuae: "TII",
	"x-ai": "xAI",
} satisfies Record<string, string>

/**
 * Model-name prefix → vendor slug, for ids that reach us without a vendor
 * segment (`claude-sonnet-4-5-20250929`, `gpt-4o`, `llama3.1:8b`). Matched in
 * order against the lowercased model segment with its variant stripped, so a
 * longer prefix goes before the shorter one it extends (`palmyra` before
 * `palm`).
 */
export const VENDOR_PREFIX_RULES: ReadonlyArray<readonly [pattern: RegExp, vendorSlug: string]> = [
	[/^claude/, "anthropic"],
	[/^(gpt|chatgpt|o[1-9](-|$)|codex|davinci|text-embedding|dall-e|whisper|tts-)/, "openai"],
	[/^palmyra/, "writer"],
	[/^(gemini|gemma|palm|bison|gecko|imagen|veo)/, "google"],
	[/^(llama|codellama)/, "meta-llama"],
	[/^(mistral|mixtral|codestral|ministral|magistral|devstral|pixtral)/, "mistralai"],
	[/^deepseek/, "deepseek"],
	[/^(qwen|qwq|qvq)/, "qwen"],
	[/^glm/, "z-ai"],
	[/^grok/, "x-ai"],
	[/^(command|aya|embed-)/, "cohere"],
	[/^kimi/, "moonshotai"],
	[/^(minimax|abab)/, "minimax"],
	[/^(nova|titan)/, "amazon"],
	[/^(phi[-\d]|orca|wizardlm)/, "microsoft"],
	[/^nemotron/, "nvidia"],
	[/^(sonar|pplx)/, "perplexity"],
	[/^hunyuan/, "tencent"],
	[/^(doubao|seed-)/, "bytedance-seed"],
	[/^ernie/, "baidu"],
	[/^granite/, "ibm-granite"],
	[/^lfm/, "liquid"],
	[/^hermes/, "nousresearch"],
	[/^step-/, "stepfun"],
	[/^jamba/, "ai21"],
	[/^mimo/, "xiaomi"],
	[/^reka/, "rekaai"],
	[/^solar/, "upstage"],
	[/^yi-/, "01-ai"],
	[/^inflection/, "inflection"],
	[/^dbrx/, "databricks"],
	[/^falcon/, "tiiuae"],
	[/^mercury/, "inception"],
]

/**
 * Product families that carry a mark of their own, distinct from their
 * vendor's: Claude is not the Anthropic "A", Gemini is not the Google "G".
 * Matched against the normalized model segment regardless of how the vendor
 * was resolved, so an OpenRouter hit and a heuristic one agree.
 */
export const FAMILY_RULES: ReadonlyArray<readonly [pattern: RegExp, family: string]> = [
	[/^claude/, "claude"],
	[/^gemini/, "gemini"],
	[/^grok/, "grok"],
	[/^kimi/, "kimi"],
]

/**
 * Vendors whose ids Amazon Bedrock prefixes with `<vendor>.` — optionally
 * behind a cross-region prefix — and suffixes with `-v<n>:<m>`:
 * `us.anthropic.claude-3-5-sonnet-20241022-v2:0`.
 */
export const BEDROCK_VENDORS: Readonly<Record<string, string>> = {
	ai21: "ai21",
	amazon: "amazon",
	anthropic: "anthropic",
	cohere: "cohere",
	deepseek: "deepseek",
	meta: "meta-llama",
	mistral: "mistralai",
	openai: "openai",
	qwen: "qwen",
	writer: "writer",
} satisfies Record<string, string>
