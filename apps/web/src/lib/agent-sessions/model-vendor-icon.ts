import {
	AionLabsIcon,
	AmazonIcon,
	AnthropicIcon,
	ArceeIcon,
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
	InceptionIcon,
	KimiIcon,
	KwaipilotIcon,
	LiquidIcon,
	MeituanIcon,
	MetaIcon,
	MicrosoftIcon,
	MiniMaxIcon,
	MistralIcon,
	MoonshotIcon,
	MorphIcon,
	NousResearchIcon,
	NvidiaIcon,
	OpenAiIcon,
	OpenRouterIcon,
	PerplexityIcon,
	PoolsideIcon,
	QwenIcon,
	RelaceIcon,
	StepFunIcon,
	TencentIcon,
	UpstageIcon,
	VeniceIcon,
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
	"aion-labs": AionLabsIcon,
	amazon: AmazonIcon,
	anthropic: AnthropicIcon,
	"arcee-ai": ArceeIcon,
	baidu: BaiduIcon,
	bytedance: ByteDanceIcon,
	"bytedance-seed": ByteDanceIcon,
	cognitivecomputations: VeniceIcon,
	cohere: CohereIcon,
	deepseek: DeepSeekIcon,
	google: GoogleIcon,
	"ibm-granite": IbmIcon,
	inception: InceptionIcon,
	kwaipilot: KwaipilotIcon,
	liquid: LiquidIcon,
	meituan: MeituanIcon,
	meta: MetaIcon,
	"meta-llama": MetaIcon,
	microsoft: MicrosoftIcon,
	minimax: MiniMaxIcon,
	mistralai: MistralIcon,
	moonshotai: MoonshotIcon,
	morph: MorphIcon,
	nousresearch: NousResearchIcon,
	nvidia: NvidiaIcon,
	openai: OpenAiIcon,
	openrouter: OpenRouterIcon,
	perplexity: PerplexityIcon,
	poolside: PoolsideIcon,
	qwen: QwenIcon,
	relace: RelaceIcon,
	stepfun: StepFunIcon,
	tencent: TencentIcon,
	upstage: UpstageIcon,
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
	// `hasOwn`, not `in`: the slugs come off the wire, and `constructor` is not a vendor.
	if (detected.family !== null && Object.hasOwn(FAMILY_ICONS, detected.family)) {
		return FAMILY_ICONS[detected.family] ?? ChatBubbleSparkleIcon
	}
	if (detected.vendorSlug !== null && Object.hasOwn(VENDOR_ICONS, detected.vendorSlug)) {
		return VENDOR_ICONS[detected.vendorSlug] ?? ChatBubbleSparkleIcon
	}
	return ChatBubbleSparkleIcon
}
