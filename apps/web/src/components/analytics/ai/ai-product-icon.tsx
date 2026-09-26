import { cn } from "@maple/ui/lib/utils"

import {
	AmazonIcon,
	ByteDanceIcon,
	ChatBubbleSparkleIcon,
	ClaudeIcon,
	CohereIcon,
	DeepSeekIcon,
	GeminiIcon,
	GrokIcon,
	type IconComponent,
	KimiIcon,
	MetaIcon,
	MicrosoftIcon,
	MistralIcon,
	OpenAiIcon,
	PerplexityIcon,
} from "@/components/icons"

/** Shipped brand marks by product id; the rest fall back to the generic AI mark. */
const PRODUCT_ICONS = new Map<string, IconComponent>([
	["chatgpt", OpenAiIcon],
	["claude", ClaudeIcon],
	["gemini", GeminiIcon],
	["perplexity", PerplexityIcon],
	["copilot", MicrosoftIcon],
	["meta", MetaIcon],
	["doubao", ByteDanceIcon],
	["deepseek", DeepSeekIcon],
	["grok", GrokIcon],
	["mistral", MistralIcon],
	["kimi", KimiIcon],
	["amazon", AmazonIcon],
	["cohere", CohereIcon],
])

export function AiProductIcon({
	product,
	size = 16,
	className,
}: {
	product: string
	size?: number
	className?: string
}) {
	const Icon = PRODUCT_ICONS.get(product) ?? ChatBubbleSparkleIcon
	return <Icon size={size} className={cn("shrink-0", className)} />
}
