import {
	AmazonIcon,
	AnthropicIcon,
	BaiduIcon,
	ByteDanceIcon,
	ChatBubbleSparkleIcon,
	ClaudeIcon,
	CohereIcon,
	DeepSeekIcon,
	GeminiIcon,
	GoogleIcon,
	GrokIcon,
	IbmIcon,
	type IconComponent,
	KimiIcon,
	LiquidIcon,
	MetaIcon,
	MicrosoftIcon,
	MiniMaxIcon,
	MistralIcon,
	MoonshotIcon,
	NvidiaIcon,
	OpenAiIcon,
	OpenRouterIcon,
	PerplexityIcon,
	QwenIcon,
	StepFunIcon,
	TencentIcon,
	XaiIcon,
	ZaiIcon,
} from "@/components/icons"

/**
 * Brand marks for model vendors, keyed by the `vendorSlug` the detect
 * endpoint returns (OpenRouter's author segment). The same rule as
 * `vendorIcon` for frameworks: a vendor is listed only when its mark is one
 * we ship verbatim, and the rest fall back to the generic mark rather than to
 * a lookalike that names the wrong company.
 */
const VENDOR_ICONS: Record<string, IconComponent> = {
	amazon: AmazonIcon,
	anthropic: AnthropicIcon,
	baidu: BaiduIcon,
	bytedance: ByteDanceIcon,
	"bytedance-seed": ByteDanceIcon,
	cohere: CohereIcon,
	deepseek: DeepSeekIcon,
	google: GoogleIcon,
	"ibm-granite": IbmIcon,
	liquid: LiquidIcon,
	meta: MetaIcon,
	"meta-llama": MetaIcon,
	microsoft: MicrosoftIcon,
	minimax: MiniMaxIcon,
	mistralai: MistralIcon,
	moonshotai: MoonshotIcon,
	nvidia: NvidiaIcon,
	openai: OpenAiIcon,
	openrouter: OpenRouterIcon,
	perplexity: PerplexityIcon,
	qwen: QwenIcon,
	stepfun: StepFunIcon,
	tencent: TencentIcon,
	"x-ai": XaiIcon,
	"z-ai": ZaiIcon,
} satisfies Record<string, IconComponent>

/** Product families whose own mark outranks the vendor's: Claude over the Anthropic "A". */
const FAMILY_ICONS: Record<string, IconComponent> = {
	claude: ClaudeIcon,
	gemini: GeminiIcon,
	grok: GrokIcon,
	kimi: KimiIcon,
} satisfies Record<string, IconComponent>

/**
 * The mark for a detected model: family first, then vendor, then the generic
 * mark. Takes the two fields the detect endpoint returns for exactly this.
 */
export function modelVendorIcon(detected: {
	readonly vendorSlug: string | null
	readonly family: string | null
}): IconComponent {
	if (detected.family !== null && detected.family in FAMILY_ICONS) return FAMILY_ICONS[detected.family]!
	if (detected.vendorSlug === null) return ChatBubbleSparkleIcon
	return VENDOR_ICONS[detected.vendorSlug] ?? ChatBubbleSparkleIcon
}
