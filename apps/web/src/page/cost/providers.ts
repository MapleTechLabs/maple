import type { CostProvider } from "@maple/domain/cost"
import type { IconName } from "@maple/views/ui/icon"
import { Array as Arr, Option, Schema } from "effect"
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
	/** What its first sync brings in: this month and the last with older months after, or all it keeps. */
	firstSync: "months" | "four_weeks"
	/** What a reader of the figures must know about how this source's days come about, on its Sources row. */
	sourceNote?: string
}>

// Not every cost provider is an integration: OpenRouter supplies cost only, so it is named here.
// Cloudflare is one, but its cost source is a token of its own, not the integration's connection.
// PlanetScale's source reads through its integration's connection, and is added and removed here.
export const COST_PROVIDERS = {
	aws: {
		name: PROVIDERS.aws.name,
		icon: PROVIDERS.aws.icon,
		iconClassName: PROVIDERS.aws.iconClassName,
		requestUsd: 0.01,
		firstSync: "months",
	},
	openrouter: {
		name: "OpenRouter",
		icon: "OpenRouterIcon",
		iconClassName: "text-foreground",
		requestUsd: null,
		firstSync: "four_weeks",
	},
	cloudflare: {
		name: PROVIDERS.cloudflare.name,
		icon: PROVIDERS.cloudflare.icon,
		requestUsd: null,
		firstSync: "months",
	},
	planetscale: {
		name: PROVIDERS.planetscale.name,
		icon: PROVIDERS.planetscale.icon,
		iconClassName: "text-foreground",
		requestUsd: null,
		firstSync: "months",
		sourceNote:
			"Billed by the month: each day shows an even share of the month's invoice for each branch, and can change until the invoice closes.",
	},
} as const satisfies Record<CostProvider, CostProviderEntry>

const NAME_LIST = new Intl.ListFormat("en-GB", { type: "conjunction" })

/** The providers' names as one phrase: "A", "A and B", "A, B and C". */
export const providerNames = (providers: ReadonlyArray<CostProvider>): string =>
	NAME_LIST.format(Arr.map(providers, (provider) => COST_PROVIDERS[provider].name))

/**
 * The providers added by pasting a credential on the Cost page, which can also replace it and
 * remove the source. Each one's form and wording are in `credential-sources.ts`.
 */
export const CredentialProvider = Schema.Literals(["openrouter", "cloudflare"])
export type CredentialProvider = typeof CredentialProvider.Type

const decodeCredentialProvider = Schema.decodeUnknownOption(CredentialProvider)

/** `provider` as one whose source is its pasted credential, or null for a connection's source. */
export const credentialProviderOf = (provider: CostProvider): CredentialProvider | null =>
	Option.getOrNull(decodeCredentialProvider(provider))

/**
 * The providers whose source the page itself removes: a pasted credential's, and PlanetScale's,
 * whose connection stays. An AWS source goes with its connection's Cost module.
 */
export const RemovableProvider = Schema.Literals([...CredentialProvider.literals, "planetscale"])
export type RemovableProvider = typeof RemovableProvider.Type
