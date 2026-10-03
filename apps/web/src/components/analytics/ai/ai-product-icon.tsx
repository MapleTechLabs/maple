import type { CSSProperties } from "react"

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
	type IconProps,
	KimiIcon,
	MetaIcon,
	MistralIcon,
	OpenAiIcon,
	PerplexityIcon,
} from "@/components/icons"

/** Microsoft's four squares in their own colours; the shared icon is flattened to one. */
function MicrosoftColorIcon({ size = 24, ...props }: IconProps) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 24 24"
			width={size}
			height={size}
			aria-hidden
			{...props}
		>
			<path fill="#F25022" d="M0 0h11.377v11.377H0z" />
			<path fill="#7FBA00" d="M12.623 0H24v11.377H12.623z" />
			<path fill="#00A4EF" d="M0 12.623h11.377V24H0z" />
			<path fill="#FFB900" d="M12.623 12.623H24V24H12.623z" />
		</svg>
	)
}

/** Shipped brand marks by product id; the rest fall back to the generic AI mark. */
const PRODUCT_ICONS = new Map<string, IconComponent>([
	["chatgpt", OpenAiIcon],
	["claude", ClaudeIcon],
	["gemini", GeminiIcon],
	["perplexity", PerplexityIcon],
	["copilot", MicrosoftColorIcon],
	["meta", MetaIcon],
	["doubao", ByteDanceIcon],
	["deepseek", DeepSeekIcon],
	["grok", GrokIcon],
	["mistral", MistralIcon],
	["kimi", KimiIcon],
	["amazon", AmazonIcon],
	["cohere", CohereIcon],
])

const MONO = ["var(--foreground)", "var(--foreground)"] as const

/**
 * Each product's brand hue as [light, dark], pulled to the lightness and chroma
 * of the chart tokens so the marks sit in the palette instead of shouting over it.
 * Black-and-white brands (Grok, Kimi) stay on the foreground.
 */
const PRODUCT_COLORS = new Map<string, readonly [light: string, dark: string]>([
	["chatgpt", ["oklch(0.6 0.12 170)", "oklch(0.72 0.13 170)"]],
	["claude", ["oklch(0.63 0.14 40)", "oklch(0.72 0.13 42)"]],
	["gemini", ["oklch(0.6 0.18 258)", "oklch(0.7 0.16 258)"]],
	["perplexity", ["oklch(0.56 0.09 205)", "oklch(0.74 0.11 205)"]],
	["copilot", ["oklch(0.62 0.15 235)", "oklch(0.72 0.14 235)"]],
	["meta", ["oklch(0.56 0.21 262)", "oklch(0.68 0.18 262)"]],
	["doubao", ["oklch(0.62 0.12 200)", "oklch(0.76 0.12 200)"]],
	["deepseek", ["oklch(0.56 0.2 274)", "oklch(0.68 0.17 274)"]],
	["grok", MONO],
	["mistral", ["oklch(0.65 0.19 48)", "oklch(0.72 0.17 50)"]],
	["kimi", MONO],
	["amazon", ["oklch(0.7 0.16 70)", "oklch(0.78 0.16 72)"]],
	["cohere", ["oklch(0.58 0.08 165)", "oklch(0.72 0.09 165)"]],
	["duckduckgo", ["oklch(0.62 0.18 38)", "oklch(0.7 0.16 38)"]],
])

const FALLBACK = ["var(--muted-foreground)", "var(--muted-foreground)"] as const

type BrandStyle = CSSProperties & { "--ai-brand-light": string; "--ai-brand-dark": string }

const brandStyle = ([light, dark]: readonly [string, string]): BrandStyle => ({
	"--ai-brand-light": light,
	"--ai-brand-dark": dark,
})

const aiBrandStyle = (product: string): BrandStyle => brandStyle(PRODUCT_COLORS.get(product) ?? FALLBACK)

const AI_BRAND_SCOPE = "[--ai-brand:var(--ai-brand-light)] dark:[--ai-brand:var(--ai-brand-dark)]"

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
	return (
		<Icon
			size={size}
			style={aiBrandStyle(product)}
			className={cn("shrink-0 text-(--ai-brand)", AI_BRAND_SCOPE, className)}
		/>
	)
}
