import type { CostProvider } from "@maple/domain/cost"
import type { IconName } from "@maple/views/ui/icon"
import { Schema } from "effect"
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
	/** What a reader of the figures must know about how this source's days come about, on its Sources row. */
	sourceNote?: string
}>

// Not every cost provider is an integration: OpenRouter, Anthropic and OpenAI supply cost only, so
// they are named here.
// Cloudflare is one, but its cost source is a token of its own, not the integration's connection.
// Vercel's requests are free, like OpenRouter's.
// PlanetScale's source reads through its integration's connection, and is added and removed here.
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
	cloudflare: {
		name: PROVIDERS.cloudflare.name,
		icon: PROVIDERS.cloudflare.icon,
		requestUsd: null,
	},
	github: {
		name: PROVIDERS.github.name,
		icon: PROVIDERS.github.icon,
		iconClassName: PROVIDERS.github.iconClassName,
		requestUsd: null,
	},
	vercel: {
		name: PROVIDERS.vercel.name,
		icon: PROVIDERS.vercel.icon,
		iconClassName: PROVIDERS.vercel.iconClassName,
		requestUsd: null,
	},
	planetscale: {
		name: PROVIDERS.planetscale.name,
		icon: PROVIDERS.planetscale.icon,
		iconClassName: "text-foreground",
		requestUsd: null,
		sourceNote:
			"Billed by the month: each day shows an even share of the month's invoice for each branch, and can change until the invoice closes.",
	},
	anthropic: {
		name: "Anthropic",
		icon: "AnthropicIcon",
		iconClassName: "text-foreground",
		requestUsd: null,
	},
	openai: {
		name: "OpenAI",
		icon: "OpenAiIcon",
		iconClassName: "text-foreground",
		requestUsd: null,
	},
	// Morph serves only this month's spend so far: Maple reads it hourly and keeps the readings.
	morph: {
		name: "Morph",
		icon: "MorphBrandIcon",
		requestUsd: null,
		sourceNote:
			"Morph reports only this month's spend so far, so Maple reads it every hour and counts each day's change. What was spent before Maple's first reading shows on the month's first day, and spend after a month's last reading, up to an hour, is not counted. Morph has no split by model.",
	},
	// Read from the org's BigQuery billing export: no per-request price, but each sync's query
	// scans bytes BigQuery bills to the connection's host project.
	gcp: {
		name: PROVIDERS.gcp.name,
		icon: PROVIDERS.gcp.icon,
		requestUsd: null,
		sourceNote:
			"Read from the BigQuery billing export. Each sync runs one query, which BigQuery bills to the connection's project, usually a fraction of a cent.",
	},
} as const satisfies Record<CostProvider, CostProviderEntry>

/**
 * The providers added by pasting a credential on the Cost page, which can also replace it and
 * remove the source. Each one's form and wording are in `credential-sources.ts`.
 */
export const CredentialProvider = Schema.Literals([
	"openrouter",
	"cloudflare",
	"anthropic",
	"openai",
	"morph",
])
export type CredentialProvider = typeof CredentialProvider.Type

/** Whether a dialog step or a provider is one added by pasting a credential. */
export const isCredentialProvider = Schema.is(CredentialProvider)
