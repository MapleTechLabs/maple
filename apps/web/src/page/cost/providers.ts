import type { CostProvider } from "@maple/domain/cost"
import type { IconName } from "@maple/views/ui/icon"
import { PROVIDERS } from "../kit/providers"

/**
 * A cost provider on the Cost page: its name and mark, and what it bills its customer for one API
 * request Maple makes, in USD (null when requests are free).
 */
export type CostProviderEntry = Readonly<{
	name: string
	icon: IconName
	iconClassName?: string
	requestUsd: number | null
}>

// Not every cost provider is an integration: OpenRouter supplies cost only, so it is named here.
export const COST_PROVIDERS = {
	aws: {
		name: PROVIDERS.aws.name,
		icon: PROVIDERS.aws.icon,
		iconClassName: PROVIDERS.aws.iconClassName,
		requestUsd: 0.01,
	},
	openrouter: {
		name: "OpenRouter",
		icon: "OpenRouterIcon",
		iconClassName: "text-foreground",
		requestUsd: null,
	},
} as const satisfies Record<CostProvider, CostProviderEntry>
