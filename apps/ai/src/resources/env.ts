/**
 * The ai Worker's config-sourced env, resolved as one `Config`. An explicit catalog, as in
 * `apps/api/src/resources/env.ts`. The tools query the warehouse as the calling org, so this is
 * largely api's set.
 */
import type { MapleDomains, MapleRegion, MapleStage } from "@maple/infra/cloudflare"
import { mapleServerEnv, merge, optionalPlain } from "@maple/infra/env"
import * as Secrets from "@maple/infra/secrets"

export const aiConfiguredEnv = (input: {
	readonly stage: MapleStage
	readonly region: MapleRegion
	readonly domains: MapleDomains
	/** Whether this deploy has a sandbox Worker. */
	readonly sandbox: boolean
}) =>
	merge(
		// Also the GitHub App reader the source and sandbox tools resolve repositories through, and
		// the Search Console client its tools need to report a connectable org.
		mapleServerEnv(input.stage, input.region, input.domains),
		// `MAPLE_LLM_PROVIDER` picks OpenRouter (default) or Workers AI (`@/platform/Llm`).
		optionalPlain("MAPLE_LLM_PROVIDER"),
		optionalPlain("MAPLE_TRIAGE_MODEL_OPENROUTER"),
		optionalPlain("MAPLE_TRIAGE_MODEL_WORKERS_AI"),
		optionalPlain("MAPLE_REVIEW_MODEL_OPENROUTER"),
		Secrets.OpenRouterApiKey.optional,
		// Decision model, on Workers AI via the gateway binding (`layerDecisionModel`).
		optionalPlain("MAPLE_DECISION_MODEL"),
		// Maple's own org: the only one `list_maple_feedback` reads across orgs for.
		optionalPlain("MAPLE_INTERNAL_ORG_ID"),
		// Required wherever a sandbox Worker deploys: without it every sandbox call is refused.
		...(input.sandbox ? [Secrets.SandboxInternalServiceToken.required] : []),
	)
